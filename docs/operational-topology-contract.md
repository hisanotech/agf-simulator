# 合成運行グラフ・交通制御契約

本書は、実CADレビューが完了する前に区間走行と交通制御を決定的に検証するための、公開用合成モデルを定義する。関連：[論理マップ](logical-map.md) / [区間レビュー契約](reviewed-topology-contract.md) / [実装計画](implementation-plan.md)。

## 1. 三層の分離

| 層 | スキーマ／実装 | 用途 | 実行可否 |
| --- | --- | --- | --- |
| 抽象制約 | `reference-logical-map-v1` | G01～G17、通路・設備間の確認済み関係と未確定事項 | 物理走行不可 |
| CADレビュー | `reviewed-topology-v2` | 非公開図面上で確認した点・接続・通行候補 | 距離・交通条件不足のため物理走行不可 |
| 合成運行 | `operational-topology-v1` | 架空座標・距離・速度による区間走行、交通制御、UI回帰 | `motionModel: synthetic_graph`でのみ実行可 |

合成運行グラフは実CADの代替物ではない。`datasetKind=synthetic`、`evidence=synthetic-assumption`、`coordinateSystem=synthetic-display`、`physicalEtaAllowed=false`を必須とし、合成距離・時間を実測距離・確定ETAとして表示しない。

## 2. グラフ契約

`src/map/operational-topology.mjs`は次を提供する。

| 関数 | 責務 |
| --- | --- |
| `validateOperationalTopology(graph)` | ノード、方向別レーン、距離、移動種別別速度、資源、シャッター、公開可能な合成根拠を検証する。 |
| `resolveInterfaceNode(graph, interfaceId)` | 完全一致を優先し、次に最長のワイルドカード一致で設備インターフェースをノードへ対応付ける。 |
| `findOperationalPath(graph, from, to, options)` | 空走・積載・充電とタスク種別に適合する方向付き最短モデル時間経路を返す。 |

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

AGF位置は保存済みの`movement.current`、`enteredAt`、`exitAt`から線形補間する。UIは再探索、予約、状態変更を行わない。経路・位置・交通待ち分析・CSVは同じイベント／スナップショットを根拠とする。

## 5. 公開合成フィクスチャと受入範囲

`examples/synthetic-operational-topology.json`は架空の13ノード・13エッジを持つ。01～05、空走／積載、充電、1／2車線、交差点資源、合成シャッターを自動テストするためのもので、現場形状・距離・速度・設備位置を表さない。

自動テストの受入範囲は、決定性、方向・移動種別制限、到達不能、原子的予約、対向競合、交差点排他、シャッター待ち、充電移動、イベント由来の位置投影である。実CADへの対応、実寸距離、車体幅・旋回、信号I/O、安全認証、現場性能は受入範囲外とする。
