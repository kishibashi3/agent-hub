# agent-hub docs

agent-hub の理念・設計議論。実装の手順は repo ルートの `README.md` を参照。

## 思想 / 理念

- [collaboration-model.md](./collaboration-model.md) — 共在 (co-presence) の協働モデル。HITL を「概念として溶かす」設計
- [messaging-vs-rpc.md](./messaging-vs-rpc.md) — agent-hub が messaging primitive を選んだ思想的根拠 (RPC との対比)

## 設計

- [agent-bridges.md](./agent-bridges.md) — peer worker / bridge の設計思想と実装パターン

## 競合 / 調査

- [landscape.md](./landscape.md) — 「人＋エージェントが対等に共在する協働空間」観点の競合 positioning
- [a2a.md](./a2a.md) — Google A2A プロトコル調査 (非採用、ハブ型不適合)
