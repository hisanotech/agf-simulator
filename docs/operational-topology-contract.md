# 合成運行グラフ・交通制御契約

本書は、実CADレビューが完了する前に区間走行と交通制御を決定的に検証するための、公開用合成モデルを定義する。関連：[論理マップ](logical-map.md) / [区間レビュー契約](reviewed-topology-contract.md) / [実装計画](implementation-plan.md)。

## 1. 三層の分離

| 層 | スキーマ／実装 | 用途 | 実行可否 |
| --- | --- | --- | --- |
| 抽象制約 | `reference-logical-map-v1` | G01～G17、通路・設備間の確認済み関係と未確定事項 | 物理走行不可 |
| CADレビュー | `reviewed-topology-v2` | 非公開図面上で確認した点・接続・通行候補 | 距離・交通条件不足のため物理走行不可 |
| 合成運行 | `operational-topology-v1` | 架空座標・距離・速度による区間走行、交通制御、UI回帰 | `motionModel: synthetic_graph`でのみ実行可 |

合成運行グラフは実CADの代替物ではない。`datasetKind=synthetic`、`evidence=synthetic-assumption`、`physicalEtaAllowed=false`を必須とし、合成距離・時間を実測距離・確定ETAとして表示しない。旧回帰入力は `coordinateSystem=synthetic-display`、縮尺を揃えるモデルは `coordinateSystem=synthetic-mm` とする。

### mm配置モデル（2026-10-05）

`src/map/metric-layout.mjs` は明示された `metric-layout-profile-v1` の軸アンカーから、旧概念座標をmmへ変換する。ノードと経路点、設備・建屋の描画は同じ変換を使い、mmモデルの各 `distanceMm` はそのmm経路の長さと一致しなければならない。曲がりの分割はmm区間長を保持する。画面は縦横同じ倍率で投影し、文字・AGF記号の表示サイズを設備位置から分離する。旧入力の独立距離・等分分割は過去Run再現用に保持する。

任意の `xBands` はPZの個別間隔補正とWHの等間隔配置を分離し、外通路では宣言された帯の間を補間する。接続や未指定の曲がりノードは追加しない。設備の概念枠・文字は描画記号であり、荷役面中心を保存済み停止点に揃えても実設備の大きさ・実停止位置の承認を意味しない。

公開UIの既定は `examples/synthetic-metric-layout.mjs` の架空寸法。ローカルのループバックホストでのみ、無視対象の `private/metric-layout-profile.json` があれば使用する。実図由来の値・画像・比較ログは公開ファイルへ転記しない。非公開プロファイルも縮尺・原点・設備停止位置・現場通行承認へ自動昇格しない。`metricScaleVerified=false`、`physicalEtaAllowed=false` を維持し、旧待機／充電場所を校正アンカーにしない。

保存済みScenarioはプロファイルのID・改訂・根拠・アンカー、全ノード座標・全経路点・距離・速度を保持し、Run条件と条件CSVから再現できる。新しい配置を読み込んでも保存済みRunを書き換えない。

## 2. グラフ契約

`src/map/operational-topology.mjs`は次を提供する。

| 関数 | 責務 |
| --- | --- |
| `validateOperationalTopology(graph)` | ノード、方向別レーン、距離、移動種別別速度、資源、シャッター、公開可能な合成根拠を検証する。 |
| `resolveInterfaceNode(graph, interfaceId)` | 完全一致を優先し、次に最長のワイルドカード一致で設備インターフェースをノードへ対応付ける。 |
| `findOperationalPath(graph, from, to, options)` | 空走・積載・充電・HP復帰とタスク種別に適合する方向付き最短モデル時間経路を返す。 |

探索時間は各区間について `ceil(distanceMm * 1000 / speedMmPerSec)`。同時間の候補はエッジID列の辞書順で決定し、JSON配列順に依存しない。戻り値は`modelDistanceMm`と`modelDurationMs`であり、`measuredDistanceMm`は常に`null`、`etaStatus`は`synthetic-assumption`とする。

## 3. 交通制御

`src/core/traffic-controller.mjs`はレーンIDと交差点等の`occupancyResourceIds`を一括予約する。全資源を同時取得できる場合だけ進入し、退出時に解放する。

- 1車線はレーン容量1。
- 2車線は方向別の独立レーンとして管理する。
- `both`は両方向から利用可能という意味であり、同一レーン上の同時すれ違いを許可しない。
- 交差点資源は複数区間間で排他となる。
- シャッター不許可時は進入せず、許可イベント後に再要求する。
- 待ちグラフの循環を`DEADLOCK_DETECTED`として記録する。復旧方針は`detect-only`であり、自動退避や優先順位の推測は行わない。

## 4. イベントとUI

合成グラフを指定したシナリオだけが`ROUTE_PLANNED`、`SEGMENT_REQUEST`、`SEGMENT_WAITING`、`SEGMENT_ENTERED`、`SEGMENT_EXITED`、`ROUTE_COMPLETED`等を生成する。既存の固定時間シナリオは従来語彙と結果を維持する。

AGF位置は保存済みの`movement.current`、`enteredAt`、`exitAt`から区間の折れ線に沿って補間する。旧 `synthetic-display` の `displayPath` は描画専用。`synthetic-mm` はmmモデル座標として距離と一致させるが、実測CAD距離・確定ETAではない。UIは再探索、予約、状態変更を行わない。経路・位置・交通待ち分析・CSVは同じイベント／スナップショットを根拠とする。

## 5. 公開合成フィクスチャと受入範囲

`examples/synthetic-operational-topology.json`は架空の15ノード・15エッジを持つ。01～05、空走／積載、充電、1／2車線、交差点資源、合成シャッターを自動テストするためのもので、現場形状・距離・速度・設備位置を表さない。

自動テストの受入範囲は、決定性、方向・移動種別制限、到達不能、原子的予約、対向競合、交差点排他、シャッター待ち、充電移動、イベント由来の位置投影である。実CADへの対応、実寸距離、車体幅・旋回、信号I/O、安全認証、現場性能は受入範囲外とする。

## 6. ローカル追加契約

`wait`移動種別とHP1／HP2を追加。`postTaskPolicy`を指定すると搬送・充電完了後に同じ交通制御でHPへ復帰する。[製品・HP契約](warehouse-product-wait-contract.md)参照。`permissionEvents`のwarehouse/magazine対象は合成入力の許可変更で、荷下ろし前の不許可を保留し復旧で再開する。実PLC信号ではない。`SHUTTER_STATE_CHANGED`は`shutterId`・`passable`、全合成運行イベントは`etaStatus: synthetic-assumption`をCSVにも保持する。
