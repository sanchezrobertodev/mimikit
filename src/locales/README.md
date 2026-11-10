# Translations

Each folder is a language (`en`, `es`, …) with one JSON file per part of the app, in the
[i18next v4 JSON format](https://www.i18next.com/misc/json-format). English (`en`) is the source: every other
language has the same files and keys. `make check` runs `src/lib/locales.test.ts`, which says what is missing.

- **Placeholders** such as `{{count}}` or `{{name}}` are filled in by the app. Keep them as they are, anywhere in the
  sentence. Numbers are formatted for the language.
- **Tags** such as `<0>Space</0>` or `<0/>` mark text the app styles (a key cap, a bold number). Keep the numbers and
  wrap the matching words; `<0/>` is replaced by something from the app.
- **Plurals:** `key_one`, `key_other` (and `key_many`, `key_few`, `key_zero` where the language uses them) are the
  forms of one sentence for different counts, chosen by
  [CLDR plural rules](https://www.unicode.org/cldr/charts/latest/supplemental/language_plural_rules.html). `_other`
  is required; a missing form falls back to it. A `_zero` form, where there is one, wins for 0. A singular form may
  drop `{{count}}` ("The other image takes…"), but not in French or Portuguese, where `_one` is also used for 0.
- **Search syntax stays English:** `type:`, `in:`, `#`, `size:`, `dur:`, `rating:`, `note:`, `color:` and their
  values are typed by the user and read by the app. They are passed in as placeholders, so they never appear in these
  files.
- `errors.json` holds messages from the app's backend. The English text must stay exactly as the backend writes it:
  the app recognises a message by it.
- `fmt.json` → `time.relativeStyle` is the [`Intl.RelativeTimeFormat`](https://developer.mozilla.org/docs/Web/JavaScript/Reference/Global_Objects/Intl/RelativeTimeFormat/RelativeTimeFormat#style)
  style for "3h ago" in that language: `narrow`, `short` or `long`. Leave it untranslated.
- A new language also needs its own name in `src/locales.ts` (`NAMES`) and, for the Windows installer, in
  `bundle.windows.nsis.languages` in `src-tauri/tauri.conf.json`.

## Glossary

Gamedev terms that are usually left in English stay in English: sprite, sprite sheet, tileset, atlas, mesh, shader,
glTF, FBX, OBJ, PSD. Product names stay as they are: Mimikit, Ko-fi, GitHub.

| English | Español (Latinoamérica) | Português (Brasil) | Français | Deutsch | 日本語 | 简体中文 |
|---|---|---|---|---|---|---|
| asset | recurso | recurso | ressource | Asset | アセット | 资源 |
| library | biblioteca | biblioteca | bibliothèque | Bibliothek | ライブラリ | 资源库 |
| folder | carpeta | pasta | dossier | Ordner | フォルダー | 文件夹 |
| collection / smart collection | colección / colección inteligente | coleção / coleção inteligente | collection / collection intelligente | Sammlung / intelligente Sammlung | コレクション / スマートコレクション | 合集 / 智能合集 |
| favorite (noun / verb) | favorito / marcar como favorito | favorito / favoritar | favori / ajouter aux favoris | Favorit / als Favorit markieren | お気に入り / お気に入りに追加 | 收藏 / 收藏 |
| tag | etiqueta | tag | tag | Tag | タグ | 标签 |
| rating, stars | calificación, estrellas | avaliação, estrelas | évaluation, étoiles | Bewertung, Sterne | 評価、星 | 评分、星 |
| note | nota | nota | note | Notiz | メモ | 备注 |
| duplicate | duplicado | duplicata | doublon | Duplikat | 重複 | 重复项 |
| Insights (view) | Estadísticas | Estatísticas | Statistiques | Statistiken | 統計 | 统计 |
| side panel, quick view | panel lateral, vista rápida | painel lateral, visualização rápida | panneau latéral, aperçu rapide | Seitenbereich, Schnellansicht | サイドパネル、クイックビュー | 侧边面板、快速预览 |
| full screen | pantalla completa | tela cheia | plein écran | Vollbild | 全画面 | 全屏 |
| thumbnail | miniatura | miniatura | miniature | Vorschaubild | サムネイル | 缩略图 |
| frame (animation) | fotograma | quadro | frame | Frame | フレーム | 帧 |
| waveform | forma de onda | forma de onda | forme d'onde | Wellenform | 波形 | 波形 |
| import, scan | importar, escanear | importar, escanear | importer, scanner | importieren, scannen | インポート、スキャン | 导入、扫描 |
| image analysis, analyse | análisis de imágenes, analizar | análise de imagens, analisar | analyse d'images, analyser | Bildanalyse, analysieren | 画像解析、解析 | 图像分析、分析 |
| Find similar | Buscar similares | Encontrar semelhantes | Trouver des similaires | Ähnliche finden | 類似を検索 | 查找相似 |
| Find related | Buscar relacionadas | Encontrar relacionadas | Trouver des images liées | Verwandte finden | 関連を検索 | 查找相关 |
| backup, restore | copia de seguridad, restaurar | backup, restaurar | sauvegarde, restaurer | Sicherung, wiederherstellen | バックアップ、復元 | 备份、恢复 |
| Trash | Papelera | Lixeira | Corbeille | Papierkorb | ごみ箱 | 回收站 |
| Settings | Configuración | Configurações | Paramètres | Einstellungen | 設定 | 设置 |
| theme, accent colour | tema, color de acento | tema, cor de destaque | thème, couleur d'accentuation | Design, Akzentfarbe | テーマ、アクセントカラー | 主题、强调色 |
| keyboard shortcut | atajo de teclado | atalho de teclado | raccourci clavier | Tastenkürzel | キーボードショートカット | 键盘快捷键 |
| update | actualización | atualização | mise à jour | Update | アップデート | 更新 |
| Ctrl (key) | Ctrl | Ctrl | Ctrl | Strg | Ctrl | Ctrl |
| Space, Shift, Scroll (keys) | Espacio, Mayús, Rueda | Espaço, Shift, Roda do mouse | Espace, Maj, Molette | Leertaste, Umschalt, Mausrad | Space, Shift, ホイール | 空格, Shift, 滚轮 |
