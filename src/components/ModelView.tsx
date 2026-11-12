import clsx from "clsx";
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { errorText } from "../api";
import { t } from "../lib/i18n";
import { addLights, dispose, frame, loadModel, stats } from "../lib/models";
import { onThemeColors, reducedMotion, themeColor } from "../lib/prefs";
import type { Asset } from "../types";
import { chip, Note, toggleChip, usePreviewFailure } from "./Viewers";

// Its own chunk: three.js loads on the first model preview, not at startup.
export default function ModelView({ asset, full }: { asset: Asset; full: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [wireframe, setWireframe] = useState(false);
  // Turning the model without dragging it (WCAG 2.5.7).
  const [spin, setSpin] = useState(false);
  // Animated models play their first clip unless the OS asks for reduced motion; full screen can toggle it.
  const [playClip, setPlayClip] = useState(() => !reducedMotion());
  const playing = useRef(playClip);
  playing.current = playClip;
  const [info, setInfo] = useState<{ vertices: number; triangles: number; clips: number } | null>(null);
  const fail = usePreviewFailure();
  const wire = useRef<(on: boolean) => void>(() => {});
  const reset = useRef<() => void>(() => {});
  const rotate = useRef<(on: boolean) => void>(() => {});

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    setInfo(null);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    addLights(scene);
    const camera = new THREE.PerspectiveCamera(40, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    rotate.current = (on) => {
      controls.autoRotate = on;
    };
    const clock = new THREE.Clock();
    let mixer: THREE.AnimationMixer | null = null;
    let object: THREE.Object3D | null = null;
    let grid: THREE.GridHelper | null = null;
    // The grid bakes its colours in, so a theme change builds a new one.
    const placeGrid = (size: number, y: number) => {
      if (grid) {
        scene.remove(grid);
        grid.dispose();
      }
      grid = new THREE.GridHelper(size, 20, new THREE.Color(themeColor("--line-x")), new THREE.Color(themeColor("--line")));
      grid.position.y = y;
      scene.add(grid);
    };
    let regrid = () => {};
    const offTheme = onThemeColors(() => regrid());
    let raf = 0;
    let live = true;

    const resize = () => {
      const { clientWidth: w, clientHeight: h } = el;
      renderer.setSize(w, h);
      camera.aspect = w / Math.max(1, h);
      camera.updateProjectionMatrix();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(el);
    resize();
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const dt = clock.getDelta();
      if (playing.current) mixer?.update(dt);
      controls.update();
      renderer.render(scene, camera);
    };
    loop();

    loadModel(asset, renderer)
      .then(({ object: o, animations }) => {
        if (!live) return dispose(o);
        object = o;
        scene.add(o);
        const r = frame(camera, o, controls.target);
        reset.current = () => frame(camera, o, controls.target);
        const floor = new THREE.Box3().setFromObject(o).min.y;
        regrid = () => placeGrid(r * 4, floor);
        regrid();
        if (animations.length) {
          mixer = new THREE.AnimationMixer(o);
          mixer.clipAction(animations[0]).play();
          mixer.update(0);
        }
        wire.current = (on) =>
          o.traverse((c) => {
            const m = (c as THREE.Mesh).material;
            for (const mat of Array.isArray(m) ? m : m ? [m] : []) (mat as THREE.MeshStandardMaterial).wireframe = on;
          });
        setInfo({ ...stats(o), clips: animations.length });
      })
      .catch((e) => live && fail(errorText(e)));

    return () => {
      live = false;
      offTheme();
      cancelAnimationFrame(raf);
      ro.disconnect();
      controls.dispose();
      if (object) dispose(object);
      renderer.dispose();
      // Frees the WebGL context now, not at garbage collection: past 16 live contexts the browser kills the oldest,
      // which is the one model thumbnails render with.
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [asset.id, asset.path, asset.mtime, fail]);

  useEffect(() => wire.current(wireframe), [wireframe, info]);
  useEffect(() => rotate.current(spin), [spin, info]);

  return (
    <div className={clsx("stripes relative w-full overflow-hidden rounded-xl", full ? "h-full" : "h-[200px]")}>
      <div ref={box} className="h-full w-full" />
      {!info && (
        <div className="pointer-events-none absolute inset-0">
          <Note busy>{t("modelView.loading")}</Note>
        </div>
      )}
      {info && (
        <div className="absolute bottom-2.5 left-2.5 flex flex-wrap items-center gap-1.5">
          <span className={chip}>
            {t("modelView.triangles", { count: info.triangles })} · {t("modelView.vertices", { count: info.vertices })}
            {info.clips > 0 && ` · ${t("modelView.clips", { count: info.clips })}`}
          </span>
          {full && (
            <>
              <button type="button" aria-pressed={wireframe} onClick={() => setWireframe((w) => !w)} className={toggleChip(wireframe)}>
                {t("modelView.wireframe")}
              </button>
              {info.clips > 0 && (
                <button type="button" aria-pressed={playClip} onClick={() => setPlayClip((p) => !p)} className={toggleChip(playClip)}>
                  {t("modelView.animate")}
                </button>
              )}
              <button type="button" aria-pressed={spin} onClick={() => setSpin((on) => !on)} className={toggleChip(spin)}>
                {t("modelView.autoRotate")}
              </button>
              <button type="button" onClick={() => reset.current()} className={clsx(chip, "font-sans")}>
                {t("modelView.resetView")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
