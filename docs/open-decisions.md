# Open decisions (keep out of public fixtures)

Full customer/site requirements and CAD layouts remain outside this public repository pending publication approval.

- Each of the 8 lines has an individually editable discharge interval (minutes) on the settings screen; default interval, fractional precision, and persistence across sessions are unresolved. Input generated from intervals must not be represented as actual PLC history.
- The uploaded DXF has `$INSUNITS=0`; the user considers its model units likely mm. The display-only private preview can use an explicit mm assumption, but physical scale remains unverified until compared with a known length. The reference origin, relevant layer semantics, and unresolved INSERTs remain open. Do not derive approved mm distances or ETA from this preview.
- Per-line pickup points and georeferenced equipment coordinates.
- Physical route graph, actual turn/stop points, individual slot-to-row map, shutter-specific stopping points and transit times. The [abstract logical map](logical-map.md) records confirmed corridor relationships but is not measured physical routing. Use the [route annotation guide](route-annotation-guide.md); do not silently promote provisional paths to confirmed geometry.
- Battery consumption baseline is now 70 percentage points per 360 minutes of driving and handling (supplier assumption relayed by the user on 2026-09-25; active-time scope explicitly user-confirmed). Idle, blocked unloading and charger queues are excluded; charging travel is included. Load/speed/distance-specific rates, auxiliary idle consumption, physical charging routes, mid-task charge interruption and pre-dispatch completion-energy reservations remain unresolved. See [AGF specification](specs/07-agf.md).
- Wrapper/labeler exact durations and blocking/interlock behavior.
- Initial magazine quantities, physical capacity and source readiness timeline.
- Transport-type priority and preemption policy.
- Local dashboard layout, reservation dialog and CSV implementation are available for user review; final acceptance, persistence across browser reloads and actual warehouse slot coordinates remain open. See [dashboard implementation](ui-dashboard.md).
- Warehouse structure is confirmed at 802PL; east column 10 is empty and its traversability unresolved. Four main aisles (west two/east two) have unreviewed individual directions, lanes and passing conditions. Row side-by-side passing is prohibited.
- The upper and lower fire-shutter corridor groups remain confirmed as bidirectional, two-lane and simultaneous-passing-capable. The direction of each individual lane is unresolved and must be checked without weakening the confirmed group-level attributes.
- Normal warehouse access uses the east shutter and excludes the west shutter. The east-shutter-failure detour through the west shutter and the required palletizing entry/exit reversal are retained requirements; activation conditions, operator procedure, stops and physical route remain unresolved and non-routable.
- South of EB2: two waiting places and two distinct charging places, two charger devices, five aligners; east-main-aisle access is confirmed. Individual branches, stops, charger mapping and initial AGF physical positions remain unresolved. Empty-pallet storage below the aligners is AGF-forbidden, never a route/retreat/pickup point.
- Four warehouse waiting candidates are retained: two south of EB2 and two near the central fire-shutter pillars (west one/east one). WS1-WS4 mapping, pillar clearance and stop geometry remain unresolved.
- Dispatch mode `area_first` now prioritizes eligible AGFs at the **destination/drop-off area** by lowest battery. Fallback when no eligible AGF is in that area and equal-battery tie handling need confirmation; the engine already implements destination-area priority; ID tie breaks and optional cross-area fallback remain explicit model assumptions.

Use an explicit scenario schema and synthetic values until confirmed. Never silently resolve these by guessing.

## 2026-09-29 追加指示の未確定事項

- 各系列およびSPECIALの実際の初期行割当、ブロックを跨ぐ連続判定、複数行の入庫順位。入力未設定を現場の初期値へ置き換えない。
- AGFごとの固定HP、HP1／HP2の優先順位、HP満杯時の待機先、柱前候補を通常HPとして使う条件。合成例の復帰先は明示したテスト入力に限る。
- 充電完了後にHPも次タスクも成立しない場合の安全な退避・充電位置解放。現実の出発先が不明なため、合成モデルでも占有保持と理由付き保留にする。
- 実車の減速・加減速・車体離隔、同一行占有の実信号境界、個別棚停止点。現在の合成倉庫は代表荷下ろしノードであり、802個の実座標経路ではない。
- UIのレイヤー切替、CADレビューの詳細ツールへの追加分離は次段階。今回の画面構造は維持する。
