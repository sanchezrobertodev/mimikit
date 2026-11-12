import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OBJLoader } from "three/examples/jsm/loaders/OBJLoader.js";
import { MTLLoader } from "three/examples/jsm/loaders/MTLLoader.js";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import { STLLoader } from "three/examples/jsm/loaders/STLLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { KTX2Loader } from "three/examples/jsm/loaders/KTX2Loader.js";
import { VOXLoader, buildMesh } from "three/examples/jsm/loaders/VOXLoader.js";
import { ColladaLoader } from "three/examples/jsm/loaders/ColladaLoader.js";
import { TDSLoader } from "three/examples/jsm/loaders/TDSLoader.js";
import { PLYLoader } from "three/examples/jsm/loaders/PLYLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { fileUrl } from "../api";
import type { Asset } from "../types";
import { mtlCandidates } from "./mtl.ts";

export interface LoadedModel {
  object: THREE.Object3D;
  animations: THREE.AnimationClip[];
}

const defaultMaterial = () => new THREE.MeshStandardMaterial({ color: 0xb8c2d6, roughness: 0.7, metalness: 0.05 });

// One of each for the whole window: they keep a pool of workers. With no path set they load their decoders from
// next to themselves (new URL(…, import.meta.url)), which Vite copies into the build: nothing comes from a CDN.
let draco: DRACOLoader | undefined;
let ktx2: KTX2Loader | undefined;

/** Loads a model. `renderer` is the one it will be drawn with: KTX2 textures are transcoded to a format its GPU takes. */
export async function loadModel(asset: Asset, renderer: THREE.WebGLRenderer): Promise<LoadedModel> {
  const url = fileUrl(asset.path);
  switch (asset.ext) {
    case "glb":
    case "gltf": {
      draco ??= new DRACOLoader();
      ktx2 ??= basisWorkers(new KTX2Loader().detectSupport(renderer));
      // Files packed with gltfpack or glTF-Transform use EXT_meshopt_compression, which GLTFLoader only reads with this.
      const g = await new GLTFLoader()
        .setMeshoptDecoder(MeshoptDecoder)
        .setDRACOLoader(draco)
        .setKTX2Loader(ktx2)
        .loadAsync(url);
      return { object: g.scene, animations: g.animations };
    }
    case "fbx": {
      const o = await new FBXLoader().loadAsync(url);
      return { object: o, animations: o.animations };
    }
    case "obj": {
      const text = await (await read(asset, url)).text();
      const loader = new OBJLoader();
      const libs = await loadMtls(mtlCandidates(asset.path, text));
      // OBJLoader only calls create(name): take each material from the first library that defines it, so every
      // library keeps resolving textures against its own folder.
      if (libs.length)
        loader.setMaterials({
          create: (name: string) => (libs.find((m) => name in m.materialsInfo) ?? libs[0]).create(name),
        } as MTLLoader.MaterialCreator);
      const o = await withTextures((textures) => {
        for (const m of libs) m.setManager(textures);
        return loader.parse(text);
      });
      if (!libs.length)
        o.traverse((c) => {
          if ((c as THREE.Mesh).isMesh) (c as THREE.Mesh).material = defaultMaterial();
        });
      return { object: o, animations: [] };
    }
    case "stl": {
      const geo = await new STLLoader().loadAsync(url);
      geo.computeVertexNormals();
      return { object: new THREE.Mesh(geo, defaultMaterial()), animations: [] };
    }
    case "dae": {
      // Textures resolve against the file's folder, which fileUrl keeps as real "/" segments.
      const text = await (await read(asset, url)).text();
      const c = await withTextures((textures) => new ColladaLoader(textures).parse(text, THREE.LoaderUtils.extractUrlBase(url)));
      if (!c) throw new Error(`Can't read ${asset.path}`);
      return { object: c.scene, animations: c.scene.animations };
    }
    case "3ds": {
      const data = await (await read(asset, url)).arrayBuffer();
      const o = await withTextures((textures) => new TDSLoader(textures).parse(data, THREE.LoaderUtils.extractUrlBase(url)));
      return { object: o, animations: [] };
    }
    case "ply": {
      const geo = await new PLYLoader().loadAsync(url);
      const colors = geo.hasAttribute("color");
      // A PLY without faces is a point cloud (a scan): drawn as dots, since triangles would be noise.
      if (!geo.index)
        return { object: new THREE.Points(geo, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: colors })), animations: [] };
      if (!geo.hasAttribute("normal")) geo.computeVertexNormals();
      const mat = defaultMaterial();
      if (colors) mat.setValues({ color: 0xffffff, vertexColors: true });
      return { object: new THREE.Mesh(geo, mat), animations: [] };
    }
    case "vox": {
      const v = await new VOXLoader().loadAsync(url);
      // Files from before MagicaVoxel 0.99 have no scene graph, only their models.
      return { object: v.scene ?? new THREE.Group().add(...v.chunks.map(buildMesh)), animations: [] };
    }
    default:
      throw new Error(`Can't preview .${asset.ext} models`);
  }
}

/** Starts the loader's workers from ktx2Worker.ts, which can run the Basis transcoder under the app's CSP (see there).
 * Otherwise the same as KTX2Loader's own worker creator. */
function basisWorkers(loader: KTX2Loader): KTX2Loader {
  loader
    .init()
    .then(() =>
      loader.workerPool.setWorkerCreator(() => {
        const worker = new Worker(new URL("./ktx2Worker.ts", import.meta.url));
        worker.postMessage(loader.workerSourceURL);
        const transcoderBinary = loader.transcoderBinary!.slice(0);
        worker.postMessage({ type: "init", config: loader.workerConfig, transcoderBinary }, [transcoderBinary]);
        return worker;
      }),
    )
    .catch(() => {}); // the model that needed it fails with the same error
  return loader;
}

async function read(asset: Asset, url: string): Promise<Response> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Can't read ${asset.path}`);
  return res;
}

/** Runs `parse` with a loading manager for the textures it starts, then waits for them: thumbnails render once
 * (failed textures count as done too). */
async function withTextures<T>(parse: (textures: THREE.LoadingManager) => T): Promise<T> {
  const textures = new THREE.LoadingManager();
  const done = new Promise<void>((r) => (textures.onLoad = r));
  let started = false;
  textures.onStart = () => (started = true);
  const result = parse(textures);
  if (started) await done;
  return result;
}

/** The .mtl files that load, in priority order: missing or broken ones are skipped, and with none the OBJ keeps the
 * neutral material. */
async function loadMtls(paths: string[]): Promise<MTLLoader.MaterialCreator[]> {
  const libs = await Promise.all(
    // Textures resolve against each .mtl's folder, which fileUrl keeps as real "/" segments.
    paths.map((p) => new MTLLoader().loadAsync(fileUrl(p)).catch(() => null)),
  );
  return libs.filter((m): m is MTLLoader.MaterialCreator => !!m && Object.keys(m.materialsInfo).length > 0);
}

export function addLights(scene: THREE.Scene) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 2.2));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(3, 5, 4);
  scene.add(key);
}

/** Points the camera at the object from a three-quarter angle so it fills the view. Returns the object's radius. */
export function frame(camera: THREE.PerspectiveCamera, object: THREE.Object3D, target?: THREE.Vector3): number {
  const box = new THREE.Box3().setFromObject(object);
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const r = sphere.radius || 1;
  const dist = r / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2));
  camera.position.copy(sphere.center).add(new THREE.Vector3(1, 0.7, 1).normalize().multiplyScalar(dist * 1.05));
  camera.near = dist / 100;
  camera.far = dist * 100;
  camera.updateProjectionMatrix();
  camera.lookAt(sphere.center);
  target?.copy(sphere.center);
  return r;
}

export function dispose(object: THREE.Object3D) {
  object.traverse((c) => {
    const m = c as THREE.Mesh;
    m.geometry?.dispose();
    const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
    for (const mat of mats) {
      for (const v of Object.values(mat)) if (v instanceof THREE.Texture) v.dispose();
      mat.dispose();
    }
  });
}

export function stats(object: THREE.Object3D) {
  let vertices = 0;
  let triangles = 0;
  object.traverse((c) => {
    const g = (c as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
    if (!g?.attributes?.position) return;
    vertices += g.attributes.position.count;
    // A point cloud's points are vertices, not triangles.
    if ((c as THREE.Mesh).isMesh) triangles += (g.index ? g.index.count : g.attributes.position.count) / 3;
  });
  return { vertices, triangles: Math.round(triangles) };
}
