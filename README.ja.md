> [!NOTE]
> **⭐ 2026 年 10 月 20 日に、Star と fork の数がゼロにリセットされました。** リポジトリが短い間、誤って非公開になっていたためです。プロジェクトは引き続き活発にメンテナンスされています。詳しくは [#115](https://github.com/edenfunf/reelmimic/issues/115) を参照してください。

<div align="center">

<img src="docs/assets/logo.svg" width="76" alt="ReelMimic">

# ReelMimic

**お気に入りの動画を見せれば、同じスタイルの新しい動画ができあがります。**

[![License: MIT](https://img.shields.io/badge/license-MIT-7A6BFF)](LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-supported-E86BD2)](https://docs.anthropic.com/en/docs/claude-code)
[![Codex CLI](https://img.shields.io/badge/Codex_CLI-supported-FF9D5C)](https://github.com/openai/codex)
![Node 22.18+](https://img.shields.io/badge/node-22.18%2B-5B57F0)
![Python 3.10+](https://img.shields.io/badge/python-3.10%2B-5B57F0)

[English](README.md) · [繁體中文](README.zh-TW.md) · [简体中文](README.zh-CN.md) · **日本語**

<table>
  <tr>
    <td align="center" width="33%"><img src="docs/assets/demo-sugar.gif" alt="Sugar Rush"></td>
    <td align="center" width="33%"><img src="docs/assets/demo-sunshine-boy.gif" alt="Sunshine Boy"></td>
    <td align="center" width="33%"><img src="docs/assets/demo-cat-bath.gif" alt="Bath Time"></td>
  </tr>
  <tr>
    <td align="center"><b>Sugar Rush</b><br><sub>ミュージックビデオ · 手描き · 58 秒</sub></td>
    <td align="center"><b>Sunshine Boy</b><br><sub>ミュージックビデオ · 手描き · 63 秒</sub></td>
    <td align="center"><b>Bath Time</b><br><sub>ナレーション付きの漫画 · 30 秒</sub></td>
  </tr>
</table>

<sub>どれも、参考動画と 1 行の指示から ReelMimic で作ったものです。プレビューは無音で、歌詞は切り取ってあります。</sub>

</div>

## これは何？

動画を見て「このスタイルで、でも完全に自分だけのものがほしい」と思ったことはありませんか？

それを ReelMimic に入れるだけです。ファイルでも、スマートフォンで録画したものでも、YouTube のリンクでもかまいません。そして、何を作りたいかを伝えます。

まず、参考動画を分解します：編集のリズム、ショットの長さ、トランジション、構図、色、カメラの動きです。それから、
あなたが確認するための計画をまとめます。そのすぐ横でチャットしたり、設定を変えたり、素材を追加したりでき、
納得したら開始します。

制作が始まると、作業は複数の AI エージェントに分担されます。動画のさまざまな部分が同時に作られ、
どのショットも、確認のために別のエージェントに渡されます。何か問題があれば修正のために差し戻されるので、
一度生成して終わり、というものではありません。

ReelMimic は参考動画がどのように作られたかを学びます。元の映像、キャラクター、素材を持ち込むことはありません。

すべてが、あなた自身のコンピューターで、あなた自身の Claude Code か Codex を使って動きます。

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/home-en-dark.png">
  <img src="docs/assets/home-en-light.png" alt="ReelMimic のホームページ" width="860">
</picture>
</p>

<p align="center">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/flow-en-dark.png">
  <img src="docs/assets/flow-en-light.png" alt="ReelMimic の仕組み" width="860">
</picture>
</p>

## できること

- **参考動画を分解します。** ショットの数、ショットの長さ、BPM、トランジション、色、構図、カメラの動き。
- **まず計画を見せます。** 絵コンテ、キャラクター、素材、いくつかのスタイルのフレーム。気に入るまでチャットで話し合ってから、承認します。
- **複数の AI エージェントが作業を分担します。** 最大 6 つのエージェントが、動画のさまざまな部分を手がけます。完成したショットはどれも、レビューのために新しいエージェントに渡されるので、誰も自分の作業を自分で採点しません。
- **修正には証拠が必要です。** どの修正にも修正前と修正後のスクリーンショットが付き、レビュー担当がそれを確認します。
- **何をしているかが見えます。** 各エージェントが何を考え、何を実行し、どのフレームを見たか。完全なログもあります。
- **動画に直接コメントできます。** 完成したら、好きな秒数に移動してメモを入力できます。まとめて一度に送れます。
- **新しいスタイルはただの Markdown です。** スタイルごとに 1 つのファイルで、コードは不要です。
- **3 つの言語。** 繁體中文、English、简体中文 に対応し、右上で切り替えられます。

## 知っておいてほしいこと

- **2D のみで、描画エンジンは 7 つ：** ベクター / モーショングラフィックス（
  [HyperFrames](https://github.com/heygen-com/hyperframes) をベース）、手描きの水彩（
  [painted-animation](https://github.com/tuzhechen2005/painted-animation) をベース）、クレヨンの絵本、ピクセルアート、
  切り絵のストップモーション、ホワイトボードの落書き、アニメのセル画です。新しい 5 つはまだ若く、最初の 2 つより
  実際に使われた経験が少なめです。参考動画が既知のスタイルに当てはまらない場合は、いちばん近いエンジンを使い、
  新しいスタイルの提案を書きます。
- **時間がかかります。** 30〜60 秒の動画は、計画を承認してから、長さと見た目によって、たいてい 1〜3.5 時間かかります。
  水彩とクレヨンは、すべてのフレームを筆で描くので、いちばん時間がかかります。
- **あなたの AI のプランを使います。** すべての作業はあなたの Claude Code か Codex のアカウントを通して動くので、
  そのアカウントの使用量に数えられます。上限に達するとジョブは一時停止し、止まったところから再開できます。
- **主に Windows でテストしています。** macOS と Linux でも動くはずですが、テストは少なめです。Issue を歓迎します。
- **実在の人物は扱いません。** 作るのはアニメーションで、実在の人物の実写映像ではありません。

## ロードマップ

- 各エンジンに、組み込みのキャラクターとスタイルを増やす
- 新しく見つけたスタイルを Web アプリから保存し、次に似た参考動画が来たら直接それに当てはめる
- 水彩の描画を速くする

## はじめに

Node.js 22.18+、Python 3.10+、FFmpeg、Chrome、そして
[Claude Code](https://docs.anthropic.com/en/docs/claude-code) か [Codex CLI](https://github.com/openai/codex) のどちらか（ログイン済み）が必要です。

```bash
git clone https://github.com/edenfunf/reelmimic.git && cd reelmimic
./install.sh      # on Windows, double-click install.bat
./start.sh        # on Windows, double-click start.bat
```

それから <http://localhost:4318> を開きます。インストールスクリプトが環境を確認し、何か足りなければ教えてくれます。
この確認は `cd app && npm run doctor` でいつでもやり直せます。Claude Code はこのリポジトリのスキルを自分で読み込み、
Codex は `AGENTS.md` を読むので、ほかに設定することはありません。

### 最初の動画

1. ホームページで参考動画を入れるかリンクを貼り付け、何がほしいかを伝え、Claude Code か Codex を選びます。
2. 分解と計画ができるのを待ちます。変えてほしいところがあれば、右側のチャットで伝えてください。スクリーンショットも使えます。
3. 計画が何か（たとえば歌詞）を求めてきたら、追加するか飛ばしてから、**Approve and start** を押します。
4. **Production line** タブには、各キャラクターと動画の各部分がどこまで進んでいるかが、レビューのスクリーンショットとともに表示されます。
5. 完成したら、おかしく見える秒数のところにメモを残します。

## 設定

API キーといくつかのパスは `~/.reelmimic/secrets.json` に書きます。このファイルはリポジトリの外にあるので、
コミットされることはありません。形式は [`secrets.example.json`](secrets.example.json) を参照してください。

| キー | 用途 |
|---|---|
| `YATING_KEY` | ナレーション用の、Yating の台湾華語の音声 |
| `ELEVENLABS_API_KEY` | 共通のオーディオエンジンを使うワークフロー向けの、オプションの ElevenLabs TTS。ReelMimic に設定した Python の環境に `elevenlabs` もインストールしてください |
| `PIXABAY_KEY`、`FREESOUND_KEY` | 使ってよい画像、音楽、効果音を増やします（オプション。Openverse はキーなしで使えます） |
| `FFMPEG_DIR`、`CHROME_PATH`、`CODEX_BIN`、`PYTHON` | これらのツールが PATH にない場合の場所 |
| `CODEX_SANDBOX` | Codex のサンドボックスのモード（デフォルトは `danger-full-access` で、Bash を許可した Claude Code と同じです。`workspace-write` では Chrome のレンダラーがブロックされます） |
| `BUILDERS`、`MAX_AGENTS` | 1 本の動画で同時に作業するエージェントの数（デフォルトは 6）と、すべてのプロジェクトを合わせた上限（デフォルトは 12） |
| `PORT` | Web のポート（デフォルトは 4318） |
| `AGENTS_TTL_MS` | 検出した Claude Code / Codex の一覧を使い回す時間（デフォルトは 300000 = 5 分。見つからないエージェントは 30 秒ごとに確認し直し、`0` ではリクエストのたびに確認し直します）。ヘッダーのエージェントのピルをクリックすると、すぐに確認し直します。新しい PATH のフォルダーにインストールした CLI には、引き続きサーバーの再起動が必要です |
| `REELMIMIC_SECRETS` | 別の secrets ファイルへのパス（旧名：`CLONE_STUDIO_SECRETS`） |
| `UPLOAD_POST_KEY`、`UPLOAD_POST_USER` | オプション。完成した動画を `npm run post-video` で TikTok、Instagram、YouTube などに投稿します（下記を参照）。`UPLOAD_POST_API` で API のアドレスを上書きできます |

### 完成した動画を投稿する（オプション）

ReelMimic が自分から何かを投稿することはありません。プロジェクトの最終レビューが終わり、動画に満足したら、
`app/` フォルダーから [Upload-Post](https://upload-post.com) を通して、自分の SNS のアカウントに送れます：

```bash
npm run post-video -- <project id> --platforms tiktok,instagram,youtube              # dry run: shows what it would post
npm run post-video -- <project id> --platforms tiktok --at 2026-10-05T18:00 --tz Europe/Madrid --send
```

`--send` を付けなければ、何もコンピューターの外に出ません。最終レビューに合格したプロジェクトしか受け付けず（必須の修正項目が残ったまま止まったものを投稿するには `--force`）、
`--title` を指定しない限り計画のタイトルを使い、
同じ動画をもう一度実行しても二重に投稿することはありません。

## ドキュメント

- [アーキテクチャ](docs/ARCHITECTURE.md)：全体がどのように動くか、ファイルがどこに置かれるか、AI がどう組み込まれるか
- [拡張](docs/EXTENDING.md)：スタイル、描画エンジン、別の AI の追加
- [コントリビューション](CONTRIBUTING.md)
- [トラブルシューティング](TROUBLESHOOTING.md)：doctor が検出するセットアップの問題と、その直し方

## 基本ルール

- 参考動画からは技法（テンポ、構図、トランジション、ギャグの決め方）を学びます。映像、キャラクター、ロゴ、素材を
  使い回すことは決してありません。
- キャラクターはオリジナルです。自分のデザインを持ち込んだ場合は、それに従います。
- オンラインで見つけたものは、入手元、作者、ライセンスとともに記録します。ライセンスがはっきりしないものには印を付けます。
- 歌詞は、あなたが渡したテキストからしか使いません。市販の曲をダウンロードすることはありません。
- 動画で何をするかはあなた次第なので、権利があることを確認してください。

## ライセンス

コードは [MIT](LICENSE) です。ここに同梱しているサードパーティのスキルと素材は、それぞれのライセンスに従います。一覧は
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) にあります。
