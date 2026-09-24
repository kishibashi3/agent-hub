# SQLite backup / restore 手順書

agent-hub hub server は SQLite の 1 ファイル (`app.db`) にすべての状態を置いている。horizontal scale をしない判断 (単一 DB) はこの規模では正しいが、その代わり **DB ファイルが単一障害点** になる。本 doc は、その単一障害点に対して何をするかを決める (issue #328 / #319 P2-1)。

- §1: 今の Pi5 で、どこに何があるか (2026-09-24 実測)
- §2: Pi5 の SD カードが死んだら何が残り、何が失われるか
- §3: 継続レプリケーション (Litestream) と定期 snapshot の比較、推奨
- §4: 定期 snapshot の取り方 (backup 手順)
- §5: restore 手順
- §6: 未確認事項と、別途判断が要るもの

> 本 doc は手順と提案だけを書く。compose・Pi5 の設定・cron の変更は本 doc の範囲外で、実施は operator の判断による。

---

## 1. 今の Pi5 の構成 (2026-09-24T01:30Z 前後に ssh で読み取り確認)

| 項目 | 値 | 確認方法 |
|---|---|---|
| 起動方式 | repo 直下の `docker-compose.yml` (systemd unit は 0 件) | `docker ps` / [deployment-pi5.md](./deployment-pi5.md) 冒頭の注意 |
| compose のある場所 | `/home/admin/agent-hub/` | `ls` |
| DB ファイル (host 側) | `/home/admin/agent-hub/data/app.db` (+ `app.db-wal` / `app.db-shm`) | `ls -la data` |
| DB ファイル (container 側) | `/app/data/app.db` | 起動ログ `[DB] Connecting to database: /app/data/app.db` |
| volume | bind mount `./data:/app/data` (hub は rw、dashboard2 は ro、scheduler は rw) | `docker inspect ... Mounts` |
| journal mode | WAL (`synchronous = NORMAL`) | `src/db/migrations.ts` の `initDatabase` |
| 保存先の物理 device | **microSD 1 枚だけ** (`/dev/mmcblk0p2`、28 GB、ext4)。NVMe は未搭載 | `lsblk` / `findmnt` |
| DB の大きさ | `app.db` 64 MB + `app.db-wal` 20 MB。gzip すると約 20 MB | `ls -l` / snapshot を gzip |
| 中身 | tenants 12 / participants 141 / messages 40,594 (2026-05-16 〜) / read_receipts 41,118 / message_causes 24,507 | snapshot に対する `select count(*)` |
| 同じ `./data` にあるもの | `schedules.json` (scheduler の entry 一覧) | `ls -la data` |
| 自動 backup | **無い** (crontab 無し、`/etc/cron.d` は `e2scrub_all` のみ、litestream 等も入っていない) | `crontab -l` / `which` |
| 手動 backup の残り | `~/backups/app.db.20260516-144000.sqlite-backup` (73 KB) と `~/agent-hub/data.bak/` (2026-06-08)。**どちらも同じ SD カード上** | `ls -la` |
| host の sqlite3 CLI | `/usr/bin/sqlite3` 3.46.1 | `sqlite3 --version` |
| `/tmp` | tmpfs (RAM 上。SD に書かない) | `findmnt /tmp` |

補足:

- hub の container には `DB_PATH=/app/data/app.db` が入っているが、server が読むのは `AGENT_HUB_DB_PATH` で、こちらは未設定である。今の DB path は、`AGENT_HUB_DB_PATH` 未設定時の default (`src/db/index.ts`、`__dirname` 相対) が **たまたま** `/app/data/app.db` に一致しているだけ (起動ログに WARN が出ている)。restore では、この path にファイルを置く。
- WAL mode では、commit 済みのデータの一部が `app.db-wal` にだけ入っている時間がある (今日の実測で 20 MB)。**`app.db` だけを `cp` した backup は、最近の書き込みが欠けるか壊れる**。backup は必ず SQLite の backup API (`sqlite3 .backup`) を使う (§4)。

---

## 2. Pi5 の SD カードが死んだら何が残り、何が失われるか

今 (2026-09-24、自動 backup なし) の状態での答え。

### 失われるもの (SD カードにしか無い)

| もの | 中身 | 取り戻せるか |
|---|---|---|
| `data/app.db` | 全 tenant の messages・participants・teams・team_members・read_receipts・message_causes (因果チェーン) | **取り戻せない**。messages は再取得できない一次データ。participants は、各 peer が接続し直せば auto-register で作り直される (owner は PAT の GitHub login)。teams は作り直しが要る |
| `data/schedules.json` | scheduler の全 entry (cron / run_at / run_in) | 取り戻せない。各 peer が登録し直す必要がある |
| `~/backups/`・`~/agent-hub/data.bak/` | 過去の手動 backup | 同じ SD にあるので一緒に失われる |
| `~/agent-hub/.env` | PAT などの secret | 値を再発行・再設定すれば戻せる |
| nginx 設定・TLS 証明書 (`/etc/nginx/sites-available/pi5-agent-hub`、`/etc/ssl/agent-hub/pi5.crt`) | reverse proxy と自己署名証明書 | 作り直せる。ただし証明書が変わると、client 側で信頼し直す必要がある (影響範囲は未確認) |
| docker volume `agent-hub_dashboard2_data` | dashboard2 の thread status など | 取り戻せない。hub の動作には影響しない |
| `~/ops-handbook.md`・`~/ops-log.md`・`~/nvme-migration.md` | Pi5 の運用メモ | 取り戻せない |

空の DB で hub を起動し直すと、community edition では default tenant の `@admin` を claim するまで named tenant に接続できない (`503 deployment_not_initialized`)。そのため、全 peer の再接続の前に `@admin` の claim が要る。

### 残るもの (SD カードの外にある)

| もの | 場所 |
|---|---|
| コードと compose 定義 | GitHub (`kishibashi3/agent-hub` など) |
| image | ghcr (`ghcr.io/kishibashi3/agent-hub` / `-scheduler` / `-dashboard2`) |
| issue・PR・review・LGTM の記録 | GitHub。merge 判断などの正本はこちらなので、状態遷移の記録は残る |
| 各 peer がやりとりした内容の一部 | 各 peer の host に残っている bridge のログ (`~/.agent-hub/logs/bridge-*.log`) や Claude Code の transcript。ただし形式は peer ごとにばらばらで、そこから `app.db` を作り直す手段は無い |

つまり今は、**SD カードが死ぬと hub の messages 履歴 (約 4 万件、2026-05-16 以降) と scheduler の entry は戻らない**。§4 の snapshot を SD の外に置けば、失うのは「最後の snapshot より後の書き込み」だけになる。

---

## 3. 継続レプリケーション vs 定期 snapshot

| 観点 | 継続レプリケーション (Litestream) | 定期 snapshot (`sqlite3 .backup` を SD の外へ pull) |
|---|---|---|
| 失うデータ量 (RPO) | 秒単位 (Litestream の default は 1 秒ごとに replicate) | snapshot の間隔ぶん (1 時間ごとなら最大 1 時間) |
| 追加するもの | Litestream の process (compose に sidecar を足す) と、replica の置き場 (S3 互換 / SFTP / GCS など) | 別 host の cron 1 行と ssh 鍵。Pi5 側には何も入れない |
| hub のコード・compose の変更 | compose に service を足す。Litestream の tips は `busy_timeout` の設定と、書き込みが多い場合は `wal_autocheckpoint = 0` を勧めている (§6) | 無し |
| SD カードへの追加の書き込み | Litestream が WAL を追いかけるための local のファイル (量は未確認) | 無し (snapshot は tmpfs の `/tmp` に作り、転送後に消す) |
| restore | `litestream restore` で任意の時点に戻せる | gzip を展開して置くだけ |
| 壊れ方 | 同じ置き場に複数の process が replicate すると restore できなくなることがある (Litestream tips) | 1 回の snapshot が失敗しても、前の snapshot は残る |
| 今日の実測 | 未実施 | 実施済み (§4.3) |

### 推奨: 定期 snapshot を今すぐ入れる。Litestream は条件がそろってから

理由:

1. **今は SD の外に backup が 1 つも無い**。一番大きいリスクは「数時間ぶん失う」ことではなく「全部失う」ことである。定期 snapshot で、それは今日から防げる。
2. 書き込みの量は少ない (messages は約 130 日で約 4 万件、1 日 300 件ほど)。1 時間ごとの snapshot で失うのは、最大でも数十件のメッセージになる。
3. 定期 snapshot は hub・compose・Pi5 に何も足さずに済み、SD への書き込みも増えない。今日、本番 DB に対して実際に動かして確かめた (§4.3)。
4. Litestream は RPO では勝るが、replica の置き場 (常時動いている S3 互換 storage か SFTP 先) が今は無い。その選定と compose の変更は operator の判断になる。

Litestream を入れるのは、次のどれかになったときでよい: (a) 1 時間ぶんの損失も許せなくなった、(b) 常時稼働の replica 先ができた、(c) NVMe へ移行するついでに compose を触る。入れるときは別 issue を起票する。

---

## 4. backup 手順 (定期 snapshot)

### 4.1 1 回分の snapshot を取る

SD の外にある host (以下「backup host」) で、次の script を実行する。Pi5 の `/tmp` (tmpfs) に snapshot を作り、`integrity_check` が `ok` のときだけ gzip して標準出力に流す。Pi5 側の一時ファイルは終了時に消える。

```bash
#!/bin/bash
# ~/bin/agent-hub-snapshot.sh
set -euo pipefail
cd ~/agent-hub-backups            # cron の作業ディレクトリは $HOME なので、保存先に移ってから書く
TS=$(date -u +%Y%m%dT%H%M%SZ)
trap 'rm -f -- *.partial' EXIT    # 途中で失敗したら書きかけのファイルを消す

ssh -o BatchMode=yes admin@192.168.3.45 '
  set -e
  T=$(mktemp /tmp/app.db.XXXXXX); trap "rm -f $T" EXIT
  sqlite3 -readonly /home/admin/agent-hub/data/app.db ".timeout 5000" ".backup $T"
  sqlite3 "$T" "pragma integrity_check" | grep -qx ok
  gzip -c "$T"
' > "app.db.$TS.gz.partial"
gzip -t "app.db.$TS.gz.partial"
mv "app.db.$TS.gz.partial" "app.db.$TS.gz"

# schedules.json も同じ data/ にあって SD にしか無いので、一緒に取る
ssh -o BatchMode=yes admin@192.168.3.45 'cat /home/admin/agent-hub/data/schedules.json' > "schedules.$TS.json.partial"
mv "schedules.$TS.json.partial" "schedules.$TS.json"
```

- 出力はいったん `.partial` に書き、ssh が exit 0 で終わり、かつ `gzip -t` が通ったときだけ `app.db.<TS>.gz` に名前を変える。`> file` のリダイレクトは backup host 側で行われるので、ssh が途中で失敗しても空か途中までのファイルが残る。それを完成品の名前で残さないためである (`set -e` で途中終了し、trap が `.partial` を消す)。
- `-readonly` で開くので、本番 DB に書き込まない。hub は止めない。WAL mode なので、snapshot 中も hub の書き込みは続けられる。
- `.backup` は SQLite の online backup API を使う。できあがるのは、backup を始めた時点の一貫した snapshot で、`app.db-wal` にしか無い commit 済みのデータも含む。途中で hub が書き込むと backup は最初からやり直しになるが、今の大きさ (64 MB) なら 0.1 秒で終わる (§4.3)。
- ファイル名の時刻は UTC (Z 付き)。Pi5 の timezone は Europe/London なので、`ls` の時刻とは 1 時間ずれることがある。

### 4.2 定期実行 (提案)

backup host の crontab に §4.1 の script を登録する例 (1 時間ごと、保存先は `~/agent-hub-backups/`):

```cron
# m h dom mon dow  command
7 * * * *  ~/bin/agent-hub-snapshot.sh >> ~/agent-hub-backups/snapshot.log 2>&1
```

- 保持の目安: 1 時間ごとのものを 48 本 + 1 日 1 本を 30 本。1 本が gzip で約 20 MB なので、合計で約 1.6 GB。
- 失敗に気づけるように、別の確認で「最新の `app.db.*.gz` が 2 時間以上前なら exit 1」などを見る。失敗した回は `.partial` のまま消えて `.gz` が増えないので、この確認で気づける。
- どの host を backup host にするか (常時稼働しているか) は未確認。§6 参照。

### 4.3 今日の実測 (2026-09-24)

本番 Pi5 に対して §4.1 のコマンドを実行した (読み取りのみ。hub は止めていない):

| 項目 | 結果 |
|---|---|
| `.backup` にかかった時間 | 0.096 秒 |
| snapshot の大きさ | 64,102,400 byte (gzip 後 20,311,521 byte) |
| `pragma integrity_check` | `ok` |
| snapshot の messages | 40,594 件、最新 `2026-09-24T01:34:21.336Z`。snapshot を取った時点の直前の書き込みまで入っていた (WAL の中身も入っている) |
| Pi5 の `/tmp` に残ったファイル | 無し (trap で消えている) |

その後、backup host (開発機) で §5.2 の手順で展開し、main の hub server を `AGENT_HUB_DB_PATH` をその copy に向けて起動した:

- 起動ログ: `[Migration] Current database version: 12` → `Database is up to date`
- `/health`: `status: ok`
- MCP で `get_history` (`X-Tenant-Id: kaz`、`to: @planner`) を呼ぶと、snapshot の直前 (01:33Z) に送ったメッセージまで返った

確認のあと、展開した copy と起動した server は消した。

---

## 5. restore 手順

### 5.1 同じ Pi5 に戻す (DB だけ壊れた、誤操作で消した等)

**hub の停止を伴うので L2 (operator の GO が要る)**。本番では未実施で、手順の検証は §4.3 の開発機での起動確認までである。

```bash
cd /home/admin/agent-hub

# 1. data/ を使う service をすべて止める (hub は rw、scheduler は rw、dashboard2 は ro で mount している)
docker compose stop agent-hub-scheduler dashboard2 agent-hub

# 2. 今の DB を 3 ファイルまとめて退避する (後で調べられるように消さない)
R=~/restore-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$R" && mv data/app.db* "$R"/
ls data/app.db* 2>/dev/null                       # 何も出ないこと

# 3. snapshot を置く (backup host から送る)
#    例: backup host で  scp app.db.<TS>.gz admin@192.168.3.45:/tmp/
gunzip -c /tmp/app.db.<TS>.gz > data/app.db
sqlite3 data/app.db "pragma integrity_check" | grep -qx ok || exit 1   # ok でなければここで止める (4 に進まない)

# 4. hub を起動し、healthy になってから scheduler と dashboard2 を起動する
docker compose up -d agent-hub
docker compose up -d agent-hub-scheduler dashboard2
```

必ず守ること:

- **`app.db-wal` と `app.db-shm` を残したまま `app.db` だけを差し替えない**。古い WAL が新しい DB に replay されて壊れる。3 ファイルとも退避してから置く (Litestream の tips も、DB を作り直すときは 3 ファイルとも消すよう書いている)。
- scheduler は hub の後で起動する。hub を再起動すると、scheduler の cron が最初の 1 回だけ 404 で落ちることがあるため (#409)。

確認:

```bash
curl -fsS http://127.0.0.1:3000/health                     # status: ok
docker logs --since 5m agent-hub 2>&1 | grep -E "\[DB\]|Migration"
#   [DB] Connecting to database: /app/data/app.db
#   [Migration] Database is up to date (または migration の適用ログ)
sqlite3 -readonly data/app.db "select count(*), max(created_at) from messages"
```

restore した後の注意:

- snapshot より後に送られたメッセージは無くなる。送った側の peer は、送れたつもりのままになる。restore したことと snapshot の時刻を、関係する peer に知らせる。
- bridge が持っている既読位置 (cursor / journal) が、restore した DB よりも先に進んでいる場合の挙動は未確認 (§6)。

### 5.2 新しい host に戻す (SD カードが死んだ)

1. 新しい host (または新しい SD / NVMe) に OS・docker を入れ、user `admin` で `git clone https://github.com/kishibashi3/agent-hub.git /home/admin/agent-hub` する。
2. `.env` を作り直す (PAT などを再設定する)。compose は `env_file:` を使わず、`environment:` に書いた変数だけが container に渡る点に注意する。
3. `mkdir -p data` をして、§5.1 の手順 3 のとおり snapshot を `data/app.db` に置く。`schedules.json` の backup があれば `data/schedules.json` に置く。
4. nginx の設定と TLS 証明書を作り直す (repo の `infra/nginx/` を参照)。
5. `docker compose pull && docker compose up -d agent-hub`。healthy になったら `docker compose up -d`。
6. §5.1 の確認をする。

snapshot が 1 つも無い場合は、空の DB で起動することになる。その場合は default tenant の `@admin` を先に claim し (§2)、各 peer が接続し直して participants を作り直す。

---

## 6. 未確認事項と、別途判断が要るもの

| 項目 | 状態 |
|---|---|
| backup host をどこにするか (常時稼働しているか、ssh 鍵を置いてよいか) | 未確認。operator の判断 |
| §4.2 の cron を実際に入れること | 本 doc の範囲外。operator の判断 |
| §5.1 の restore を本番 Pi5 で通すこと | 未実施 (L2)。開発機で snapshot から hub が起動し、`get_history` が返ることまでは確認した |
| restore 後、bridge の cursor / journal が DB より先に進んでいた場合の挙動 | 未確認 |
| TLS 証明書を作り直したときに、client 側で必要になる作業 | 未確認 |
| Litestream を入れる場合の設定 | 未検証。Litestream の tips では `busy_timeout` の設定 (better-sqlite3 の default の `timeout` は 5000 ms。hub は変更していない) と、書き込みが多い場合の `wal_autocheckpoint = 0` が挙がっている。hub は SQLite の default の autocheckpoint のまま |
| NVMe への移行 | Pi5 の `~/ops-handbook.md` で優先タスクとされているが未実施。移行しても host が 1 台なら単一障害点のままなので、SD の外への backup は別に要る |

参考:

- SQLite online backup API: https://www.sqlite.org/backup.html
- Litestream tips & caveats: https://litestream.io/tips/
