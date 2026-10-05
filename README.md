# AGF Simulator

A development harness for a deterministic, event-driven AGF logistics simulator and a simple 2D replay UI.

**Public repository notice:** The source procurement specification and CAD drawings supplied for this project are marked confidential. Do not commit their files, screenshots, exact geometry, customer/site names, or derived operational details here. Keep the full project specification outside this public repository until its visibility and publication scope are approved.

## 実装計画・現在の進捗

- **[全体進捗ボード（Issue #2）](https://github.com/zony21/agf-simulator/issues/2)**：M0～M8の状態、完了済み／未完了チェック、次に着手する項目。公開更新先。2026-09-28にmain・PRマージ済みの記述へ更新済み。未公開のローカル検証結果とは区別する。
- **[全体実装計画](docs/implementation-plan.md)**：各工程の依存関係、受入条件、検証方法。
- **[実装PR #1](https://github.com/zony21/agf-simulator/pull/1)**：2026-09-25にmainへマージ済み。M0の合成シミュレーター実装済みを示すもので、実図面での経路承認やM1～M8の完了を意味しない。

### M2 区間レビューの実装

非公開CADの下書きとは別に、区間ごとの通行可否・方向・車線数・同時通過・ゲートを**端末内で明示登録**する画面と、変更時に失効する非公開JSON台帳を追加しました。未確認・禁止・未割当ガイドは位相グラフから除外します。出力は距離・ETA・交通制御・実機の走行許可を含まない**レビュー済み位相候補**です。詳細は[区間レビュー契約](docs/reviewed-topology-contract.md)を参照してください。

### M3～M7 公開合成モデル

`motionModel: synthetic_graph`を明示した公開合成シナリオでは、架空距離・速度・座標による区間走行、方向別レーン・交差点予約、シャッター待ち、充電移動、イベント由来の位置投影・交通待ち分析・区間CSVを実行できます。既存固定時間シナリオは従来どおりです。これは実CAD経路・実測距離・確定ETA・安全認証ではありません。詳細は[合成運行グラフ・交通制御契約](docs/operational-topology-contract.md)を参照してください。

## Current scope

This repository initially contains a **development harness**, not a finished logistics simulator. It establishes trace validation, AGF dispatch selection, synthetic test fixtures, agent instructions, and CI. The current dashboard uses native JavaScript modules and SVG. Do not interpret synthetic fixtures as facility data.

## Run

Requires Node.js 22 or later. No dependency installation is necessary for the current harness.

```bash
npm test
npm run check:fixtures
npm run check
```

## Newly confirmed requirements

- The finished simulator must follow the CAD layout; the committed SVG is still a schematic, not a verified CAD reproduction.
- A settings screen must make simulation values editable, including independent per-line discharge intervals measured in minutes.
- Operators can reserve manual transport tasks 04 and 05 via UI buttons.
- Simulation results must be exportable to CSV.
- Primary AGF dispatch prioritizes eligible vehicles in the **destination/drop-off area**, then chooses the one with the lowest battery. The current simulator implements destination-area priority. Cross-area fallback is a clearly labeled scenario option rather than a confirmed site policy.

## Specifications

The ten standalone documents cover overview, equipment, normal transport 01 through 05, AGF operation, the overall 2D map, and phased AGF access/lane rules. The overview defines cross-document event, configuration, and acceptance rules. Each individual specification defines its own inputs, event sequence, state, outputs, acceptance criteria, and unresolved details.

## CAD/DXF-to-JSON map pipeline

The [DXF map pipeline guide](docs/map-dxf-pipeline.md) describes exporting the source CAD to millimetre DXF with an explicit origin, mapping layers, extracting geometry with ezdxf, supplying reviewed gates/area connectivity, and optionally rasterizing a geometric grid. The converter is [tools/dxf_to_map.py](tools/dxf_to_map.py). Run synthetic-only Python tests with `python -m unittest discover -s tests -p 'test_*.py' -v` after `pip install -r requirements-map.txt`. The [private DXF inspector](tools/inspect_dxf_private.py) accepts a DXF whose unit header is unset and retains original drawing coordinates with **unverified units**. An uploaded DXF has been examined and selected CAD-native shapes extracted privately, but **mm scale, reference origin, complete block geometry and site-specific routing remain unverified**. No real CAD or derived coordinates are committed.

## DXF-free logical map

The [public-safe abstract map JSON](data/reference-logical-map.json), [schematic 2D SVG](assets/logical-map.svg), [logical map guide](docs/logical-map.md), and [conceptual path validator](src/map/logical-map.mjs) are now available. They use confirmed corridor relationships but **not measured coordinates, detailed stop/turn points or travel times**. Run `npm run check:map`. Inter-area geometry and individual warehouse slot links remain unresolved. A synthetic 01–05 route engine is available for software verification, but no physical CAD route has been approved.


## Experimental interactive simulator (feature branch)

The repository includes a **scenario-driven discrete-event model** and Japanese replay UI. It is an offline, **synthetic/conceptual** simulator, not a CAD-calibrated physical or safety simulation.

Run with Node.js 22+ for tests, and serve the repository root with any static HTTP server for the UI:

    npm run check
    python -m http.server 8000 --bind 127.0.0.1

Then open http://localhost:8000/ . No frontend packages or build process are needed.

### Implemented simulation slice

- Four AGFs, two exclusive charger slots, scenario-configurable consumption and charging rates.
- Independent per-line minute intervals or an explicit external production event stream. Interval-generated events have inputKind=synthetic-interval, never PLC history.
- Task 01 → wrapper (one input handoff holding 1PL, internal conveyor holding up to 5PL including the pallet undergoing wrapping, a single wrapping processor, one output handoff holding 1PL) → label → exit-ready → task 02 → explicitly declared synthetic warehouse slot. The handoff and internal capacities are user-confirmed on 2026-10-02; conveyor positions and transfer durations remain unverified. The same pallet ID persists across stages. Same-row task issuance is held and location reservations prevent overbooking. Explicit legacy regression scenarios retain their older output-2PL model separately from the neutral baseline Run.
- Task 03 only on observed magazine consumption down to the trigger, with an explicitly ready aligner and a +10 refill only on drop-off.
- UI-requested tasks 04/05 use preloaded synthetic temporary pallets; reentry/storage permission and individual destination must be explicitly supplied; duplicate reservations are rejected.
- Destination-area-first/lowest-battery selection, optional explicitly selected cross-area fallback (wait is the core default), independent low-battery comparison.
- Deterministic event history/snapshots, seek/replay, state panels, same-input mode comparison, and UTF-8 BOM events CSV with run/config metadata.

The UI's warehouse slots, initial AGF areas, production intervals, source supplies and journey/handling durations are **synthetic demo values**, not confirmed site settings. Travel duration inputs are modeled constants, not derived from CAD, route geometry, speed, interlocks or traffic. The displayed floor layout is a **conceptual diagram** with schematic AGF area markers, not the uploaded drawing.

### Private CAD preview with provisional millimetre assumption

The uploaded drawing has an unset DXF unit header. The user specified millimetres for this workflow, so `tools/private_cad_preview.py` supports **explicit `--assume-mm` for display only**, without claiming independently calibrated scale or physical geometry. Its private configuration requires an explicit AGF layer exclusion, including block inserts, to avoid treating drawn AGFs as equipment. The selected source layers and SVG/report must remain outside this public repository (e.g. in `private/`). The Japanese UI can load the resulting local SVG or PNG in the dedicated CAD review dialog without uploading it; schematic AGF markers are never overlaid on private CAD. The preview is not a navigable route graph. See [DXF pipeline](docs/map-dxf-pipeline.md).

### CAD point/route annotation (feature branch)

On an AGF-excluded private preview, users can click to record explicitly named pickup, drop-off, turn, gate-wait/passage, junction, home or charger points. They can then connect existing points in order as draft empty/loaded 01–05 or charge routes, and export/import the private JSON locally. SVG annotations include the user-specified millimetre CAD coordinates derived from the SVG viewBox; PNG annotations are fractional image coordinates only. Import checks the exact background SHA-256 and viewBox. No AGF locations are inferred from AGF drawing symbols, and every route is permanently marked draft, non-routable and non-ETA. Keep exported files in private storage, not this public repository.

### Not implemented or approved

Approved CAD-to-equipment registration and verified physical node/edge graph, verified route-dependent times, real traffic/shutter/interlock conditions, automatic deadlock recovery, real production stream import UI, full exception recovery, runtime WCS/PLC/RCS integration, and physical charge-route timing. Synthetic traffic and shutter behavior exists only for deterministic software tests. The map import pipeline and private inspector are intentionally separate. Only public-safe synthetic fixtures belong in this repository.


## Planned implementation

1. Confirm equipment positions and graph nodes with the user.
2. Implement discrete-event simulation with production, transport, packaging/labeling, replenishment, charging and physical occupancy.
3. Render a simplified CAD-aligned 2D SVG map. Unconfirmed routes must appear as provisional, not measured geometry.
4. Add deterministic replay, playback controls, event log, metrics, and like-for-like dispatch-mode comparison.

See the [specification index (1 overall + 9 individual documents)](docs/specification.md), [overall map specification](docs/specs/08-map.md), [DXF-free logical map](docs/logical-map.md), [DXF map pipeline guide](docs/map-dxf-pipeline.md), [AGF access and lane specification](docs/specs/09-traffic.md), [route annotation guide](docs/route-annotation-guide.md), [AGENTS.md](AGENTS.md), [harness contract](docs/harness-contract.md), and [open decisions](docs/open-decisions.md).

The public specification includes the agreed baseline simulation settings and marks provisional values explicitly. Identifying source-document titles, original drawings, site coordinates, and operational records stay outside the repository; individual scenario values remain configurable.
## Intuitive provisional CAD route editing

After loading the private, AGF-excluded SVG/PNG preview, choose **仮線を引く** and tap a start and end point. The UI creates an explicitly unverified straight or orthogonal L-shaped draft for the selected transport 01–05/charge. Select **線を修正** to drag points, tap a segment to insert a bend point, remove a selected route point or entire route, and use undo/redo and zoom for touch devices. Existing manual point-by-point routes remain supported. Drafts are bound to the exact source image hash and SVG viewBox and can be exported/imported locally as JSON; do not commit this private output.

These are editor-generated *geometric suggestions*, not inferred passable corridors or pre-identified pickup/drop-off locations. Physical routing, AGF positions and event-engine travel times remain unchanged until a separately reviewed route/topology and explicit operating constraints are provided.

## Private initial corridor guide proposal (unassigned)

The editor now accepts **unassigned** `guide/guide` lines imported from a private, image-bound JSON draft. The working private proposal includes four explicitly provisional, editable guide strokes over the locally provided floor preview; its geometry **is not part of this public repository**. These are starting marks for human correction, not verified traversable AGF lanes or known stop points. After review, select a guide, choose task 01–05/charge and its phase, and click the explicit classification button. Classification leaves the route `draft-only`, never routable or ETA-ready.

For another private drawing, author an explicit `private/guide-seed.json` with a `guides` array of 2–200 `[u,v]` normalized points per guide (a shared junction may be written as `{"id":"JOIN","u":0.5,"v":0.5}` in several guides), then run:

```bash
node tools/build-private-route-seed.mjs --svg private/preview.svg --config private/guide-seed.json --out private/initial-guides.json
```

The script binds the draft to the exact SVG SHA-256 and viewBox, keeps guide classification unassigned and rejects output in public tracked paths. The JSON must be imported against the same SVG bytes. It does **not** infer corridors or approve a route. Do not commit the private config, preview, draft JSON or annotated screenshot.

## ローカルUIレビュー

Industrial Simulation Dashboardの5画面（搬送モニター・設定・タスク・結果・比較）、倉庫の行列段表示、独立したCADレビューを用意しています。範囲・仮定・集計定義は[UI実装ノート](docs/ui-dashboard.md)、最新版の倉庫構造は[概念契約](docs/warehouse-layout-contract.md)を参照してください。今回の変更はローカルレビュー用で、GitHubへの反映は行いません。

## 追加仕様のローカル統合（2026-09-29）

系列／特注行割当、満載・端数と2段積み、種別別搬出、HP復帰・充電優先を既存エンジンへ追加。通常・追加仕様シナリオの倉庫行割当には、ユーザー指定により「合成検証用の行割当を読込」と同じ値を編集可能な初期値として設定します。実CAD位置・経路の承認は含みません。系列→マガジンの固定対応表は確認待ちです。[追加契約](docs/warehouse-product-wait-contract.md)に入力、根拠、制限、再現手順を記載しています。1400×850の概念図と4区分の設定画面を使用します。

`node scripts/check-integrated-acceptance.mjs` で180分の正常・復旧・充電境界と同一入力比較を検証できます。出力はGit除外のprivate配下です。現場スループット・確定ETA・M8完了を表しません。
