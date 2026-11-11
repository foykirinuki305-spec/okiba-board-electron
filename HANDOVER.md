# OkibaBoard 引き継ぎメモ（性能問題の解決依頼）

## これは何か

- Windows 用 Electron アプリ「OkibaBoard」。実フォルダをボードとして表示し、素材ファイルをデスクトップのように配置・出し入れするツール。
- リポジトリ: https://github.com/foykirinuki305-spec/okiba-board-electron
- 現在の版: **v2.2.2**（HEAD `7b66fb1`、作業ツリー clean）。納品物は NSIS インストーラー `OkibaBoard-Setup-<version>.exe`（+ ポータブル版 `OkibaBoard.exe`）で、`dist-artifact/` に出力される。
- ユーザーは AviUtl で動画編集をしており、素材（大きな動画ファイルが多い）をデスクトップとボードの間で頻繁に行き来させるのが主用途。

## 依頼内容（最優先）

ドラッグ操作が実機でまだ遅い。内訳は実機ログ（`C:\OkibaBoards\okiba.log`、`dragout ms` 行）で計測済み:

```
dragout ms release=1794360391310 resolve=pre move=54 position=3054 total=3109   ← 3ファイル
dragout ms release=1794360415288 resolve=pre move=25 position=2570 total=2595   ← 1ファイル
```

- `resolve`（ドロップ先フォルダの判定）はドラッグ中の先行解決（preresolve）が効いて 0ms。`move`（実ファイル移動、同ボリューム rename）は 25–54ms。**この2つは速い。触らなくていい。**
- **遅いのは `position`（デスクトップアイコンの位置合わせ）だけで、毎回 2.5–3 秒。** ファイル数に比例しない固定コストが疑わしい。体感としては「アイコンが一時的な場所に現れ、約3秒後に指定位置へ跳ぶ」状態。
- あわせて「ボードへ入れる（取り込み）も遅い」という訴えがある。取り込み側は未計測。`intake ms` の計測行追加から始めてほしい。

### position が遅い原因の候補（優先順）

1. `scripts/shell-helper.ps1` の位置合わせ系 interop 型の **Add-Type がリクエスト毎に実行**されていないか。もしそうなら常駐ヘルパー起動時に1回だけコンパイルする（型の存在チェックでガード）。
2. アイテム毎に直列の **set → 180ms settle → readback → 最大3回 retry**。全アイテムを先に set し、後からまとめて readback 検証（不一致のみ再 set）、settle は 30–50ms に短縮、初回一致なら即終了が本線。
3. アイテム毎の OpenProcess / メモリ確保の繰り返し → 1回の呼び出しで使い回す。
4. Explorer 側のアイコン出現待ち自体が長い可能性。切り分けのため `dragout` 行に position の内訳（appear=出現待ち合計, work=set+検証）を追加してほしい。

目標: 典型ケースで position 合計が数百 ms オーダー。ユーザー実機（Windows 11、ユーザー名 keiya、デスクトップ設定: アイコンの自動整列 OFF / 等間隔に整列 ON）での体感解消がゴール。

## アーキテクチャ要点

- `main.js`（Electron main）、`renderer/`（UI、独自ポインタドラッグ）、`preload.js`。
- `scripts/shell-helper.ps1`: 常駐 PowerShell ヘルパー。JSON-lines（stdin/stdout、id 照合）で `resolveDrop` / `positionIcons` / `getDesktopPositions` / `cursorState` を提供。クライアントは `lib/shellhelper.js`。タイムアウト時は v2.1 世代のコールドスクリプト（`scripts/resolve-drop.ps1`, `scripts/position-desktop-icons.ps1`）にフォールバックする設計で、**コールド側の位置合わせは v1.3.1 で実機実証済みの既知良品**。
- `lib/preresolve.js`: ドラッグ中 ~40ms ポールでドロップ先を先行解決しキャッシュ（8px 移動 or 300ms で再解決、リリース時は 12px 以内なら採用）。
- `lib/placement.js`: 取り込み配置（ドロップしたセルをアンカーに、デスクトップ上の実アイコン配置を相対オフセットとして再現、前方スキャンで衝突回避）。ボードの広さ（heightRows/widthCols）は内容から派生、保存しない。
- `lib/links.js`: リンク方式。取り込みはファイルを動かさず、元の場所への参照を登録し Windows の Hidden 属性を付ける（デスクトップから見た目だけ消え、AviUtl の絶対パス参照が壊れない）。外すと Hidden 解除（参照カウント付き）。
- `lib/dropmove.js` / `lib/iconpos.js` / `lib/cleanup.js` / `lib/movehistory.js` / `lib/shortcut.js` / `lib/boardfs.js`。

## データモデル（互換を壊さないこと）

- データは exe の外: `C:\OkibaBoards\<ボード名>\` が実フォルダとしてボード本体。
- 各ボードの `.okiba-board.json`（v6: `positions`, `links: [{path, col, row, wasHidden}]`, テーマ、サイズ%）、基底の `.home.json`（`appVersion` マーカー含む）、`.move-history.json`（出したファイルの履歴、最新5操作・グループ形式）。
- アップデート = 本体だけ差し替え、データは引き継がれるのが前提。形式を変える場合は移行を書くこと。

## 過去に踏んだ実バグ（再発防止）

- 自動整列の判定ビットは **LVS_AUTOARRANGE = 0x0100**（0x1000 は LVS_OWNERDATA で全デスクトップに立つ）。
- デスクトップ listview の名前読み取り: LVITEM は **88 バイト確保＋テキストバッファは別**に取る。48 バイトにバッファ内蔵だとラベルが空になり名前不一致で位置合わせが無言で失敗する。Explorer プロセスは最小の VM 権限で開く（PROCESS_ALL_ACCESS は不可）。
- 座標は ScreenToClient 変換が必須（main が渡すのは画面座標）。
- `attrib` のコンソール出力はコードページで日本語ファイル名が化ける。出力をパースするなら属性フィールド（ASCII 部分）だけを見る。
- ヘルパーのワイヤは非 ASCII を `\u` エスケープする（日本語名対策）。崩さないこと。
- ボードショートカットの起動引数 `--board-path` は **`= 形式`** で書く。スペース区切りだと second-instance 経由で Chromium が値を切り離し、パーサの復元フォールバック頼みになる。
- テスト用 fake helper を Electron バイナリで起動する場合は `ELECTRON_RUN_AS_NODE=1` が必要。
- `tools/check-ps.ps1` はスクリプト毎に新しい pwsh で検査する（ヘルパーとコールドスクリプトが同名の interop 型を再定義するため）。

## 検証の回し方

- ローカル: `npm run selftest`（純ロジック、268 checks）、`npm run test:gui`（Playwright-Electron E2E、37 steps）。
- CI: push で GitHub Actions（windows-latest）が self-test / PowerShell 構文＋C# コンパイル / **実デスクトップ位置テスト（コールド版とヘルパー経由版の2本。読み戻し座標が目標のアイコン間隔以内なら PASS）** / GUI E2E / ビルド / ポータブル起動スモーク / インストーラーのサイレント導入→起動→アンインストールでデータ残存、まで回す。**位置合わせを触ったらヘルパー経由の実デスクトップテストが green であることを必ず確認。**
- ビルド: `npm run build`（electron-builder、NSIS oneClick / per-user、`createDesktopShortcut: "always"` はユーザーがショートカットを消しても再インストールで復活させるための指定なので外さないこと）。

## 進め方の約束（ユーザー方針）

- ユーザーの実機テストは最小限に。渡す前に CI で実 Windows 検証を全部通すこと。
- UI はシンプルに。ボタンや説明を増やさない。説明文は短く平易な日本語で。
- ユーザーの訴えは「入りも出しもサクッと」。速くならない最適化より、計測（okiba.log の行）で裏が取れる改善を優先してほしい。
