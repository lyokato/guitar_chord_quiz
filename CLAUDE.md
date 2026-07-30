# CLAUDE.md

Guitar Practice Tools。単一の `index.html`(HTML/CSS/JS、外部依存なし)で完結するWebアプリ。
ホーム画面から2つのツールへ遷移する: **コードクイズ**(CHORD QUIZ)と**リズムボックス**(RHYTHM BOX: ドラムパターン付きメトロノーム)。

## デザインルール(必読)

UIの生成・変更・スタイル調整を行う際は、**必ず先に `DESIGN.md` を読み、そのルールに従うこと。**
色はCSS変数のみ使用し、ボタンの役割体系・レイアウト規則・Do's and Don'ts に反する変更をしない。
デザイン上の新しい決定をしたら `DESIGN.md` を更新すること。

## ファイル構成

- `index.html` — アプリ本体(すべてここ)。単一ファイル構成を維持する。CSS/JSを別ファイルに分割しない
- `manifest.webmanifest` / `icon-*.png` / `apple-touch-icon.png` / `sw.js` — PWA用(ホーム画面追加・standalone起動・オフライン起動)。PWA要件でファイル必須のため単一ファイル構成の例外。sw.jsはネットワーク優先・失敗時キャッシュ方式
- `DESIGN.md` — UIデザインシステム(AI向けデザイン要求定義)
- `README.md` — 人間向け概要
- デプロイ: `main` へ push すると GitHub Pages に自動反映(https://lyokato.github.io/guitar_practice/)

## アーキテクチャ(index.html内のデータモデル)

問題は「ルートモード × コードタイプ × 構成 × ルート名」の組み合わせ+固定グリップ(ローコード/オンコード)で生成される。

| 定数 | 内容 |
|---|---|
| `ROOT_MODES` | ルートの取り方: `"6"`(6弦), `"5"`(5弦), `"5L"`(5弦左展開=Cシェイプ) |
| `QUALITIES` | コードタイプ: p5, maj, min, dom7, maj7, m7, m7b5, sus4, add9, h79(7(#9))。suffix=コードネーム表記, sym=設定UI表記, tones=構成音(半音) |
| `FORMS` | 構成: full(バレー), s2346, s2345, s1234, power(2音), power3(3音), s345, s234, s123, open(ローコード※UIは専用ブロック) |
| `SHAPES[mode][form][qual]` | ボイシング定義。`{弦番号: ルートフレットからのオフセット}`。**組み合わせの存在=この表に定義があること**。設定UIの選択肢(availableForms)もプール生成もここから導出される |
| `LOW_CHORDS` / `LOW_CHORD_LIST` | ローコード固定グリップ(タイプ→ルート名→{弦:フレット})。個別チェックで出題、弦・音フィルターを無視 |
| `ON_CHORDS` | オンコード固定グリップ(Dm7/G等)。同上。**5弦/6弦はどちらか一方のみ使用し、使わない方はミュート×表示** |
| `ROOT_OPTIONS` | ルート名17種(C#とD♭など異名同音は別問題として扱う。♭出題時は指板の音名も♭表記) |
| `LESSON_PRESETS` | レッスン一括設定。strings / roots(省略時変更なし) / qualForms / lowChords / onChords(省略時全OFF)。エントリ追加だけでボタンが自動生成される |
| `settings` | localStorage("chordQuizSettings")にキー単位マージで永続化 |

### フレット配置ルール(rootFret)

1. `r = (ルート音pc - 開放弦pc) mod 12`
2. `r == 0` → 12F(ただし power / power3 は開放弦ルートをそのまま使用)
3. 5L(左展開)は左に3フレット必要なため `r < 4` → +12
4. それ以外で `r == 1` かつ form が full / power / power3 以外 → 13F(1F付近はフラグメントの手型が作りにくいため)
- 指板は16フレットまで描画。オフセット計算後のフレットは 0〜16 に収まること

### その他の重要仕様

- m7♭5にバレーは存在しない(四音構成でのみ出題)。存在しない組み合わせはSHAPESに書かないことで自然に除外される
- バレーシルエット: form=full のみ。5Lは1〜3弦のR-3フレット位置
- 度数表示: `DEGREE_LABELS` + h79 の半音+3は「#9」と表示する特例
- SPA風ルーティング: History API(pushState/popstate)で home/title/settings/game/rhythm を遷移。ブラウザバックでページを離れない。`switchDom` はRHYTHM BOXを離れるとき再生を自動停止する
- サウンド: Web Audio合成。iOS対策として以下3点が必須。削除・簡略化しないこと
  1. 無音`<audio>`の**ループ再生**(unmuteハック)。ループでないと再生終了時にセッションが戻り、マナースイッチON時に消音される(実バグで確認済み)
  2. ユーザー操作内での `await ctx.resume()`
  3. 初回操作内での無音バッファのウォームアップ再生+スケジューラのクロック再同期ガード
- ただし**セッションは使用中のみ保持**: 再生終了後は`scheduleAudioRelease`で無音ループを停止+ctx.suspend(他アプリの音楽を邪魔しない)。バックグラウンド遷移(visibilitychange/pagehide)では即時解放+リズム停止

## RHYTHM BOX のアーキテクチャ

- `DRUM_PATTERNS`: 16分グリッド(拍あたり4ステップ)でパターン定義。`beats`=拍子, `swing`=シャッフル(8分裏を3連位置へ), `tracks`={楽器: ステップ配列}
- `DRUM_SOUNDS`: kick/snare/hh/oh/crash/click をWeb Audioで合成(サンプル不使用)。ノイズは共有バッファ
- スケジューラ: ルックアヘッド方式(25ms間隔のsetIntervalでAudioContextクロックの0.12秒先まで予約)。**setIntervalで直接鳴らさないこと**
- フィルイン: `FILL_PATTERNS`(off=小節末尾からのオフセットで拍子非依存)。overlay型(通常パターンに重ねる控えめ系)と置き換え型(後半を上書き)があり、crash指定時のみ次小節頭にクラッシュ。頻度は`fillEvery`。デフォルトは控えめ(soft)
- ビートインジケーター: スケジュール時に`beatEvents`へ拍時刻を積み、rAFループで点灯
- 設定は `rhythmSettings`(localStorage "rhythmSettings")に保存。BPMは再生中でも即反映

## よくある作業レシピ

- **コードタイプ追加**: `QUALITIES` にエントリ追加 → 各 `SHAPES[mode][form]` に定番の押さえ方がある構成だけ定義 → 検証実行。UIは自動追従
- **構成(フォーム)追加**: `FORMS` にキー追加 → 該当SHAPESに定義。1Fシフト除外が必要なら `NO_SHIFT_FORMS` へ
- **プリセット追加**: `LESSON_PRESETS` にエントリ1つ追加するだけ
- **ローコード/オンコード追加**: `LOW_CHORDS` / `ON_CHORDS` に追記(オンコードは5弦/6弦の片方のみ使用ルールを守る)

## 検証(変更後は必ず実行)

構成音の誤りは人間のレビューでは見つけにくい。ボイシングを触ったら必ず機械検証する:

1. `<script>` 部分を抽出して `node --check` で構文チェック
2. 全ボイシングを列挙し「全ポジションの音がQUALITIES.tonesの部分集合か」「フレット0〜16か」「form=fullのみbarreがあるか」を検証(過去の検証スクリプト例はコミット履歴 or 以下の骨子):

```js
// DOM/localStorage/history をスタブして index.html のJS(初期化前まで)を eval し、
// ROOT_MODES × FORMS × QUALITIES × 12ルートの computeVoicing() 結果を検証する
for (const mode of Object.keys(ROOT_MODES))
  for (const form of Object.keys(FORMS))
    for (const qual of Object.keys(QUALITIES)) {
      if (!SHAPES[mode][form]?.[qual]) continue;
      for (let root = 0; root < 12; root++) {
        const { positions, barre } = computeVoicing({ mode, string: ROOT_MODES[mode].stringNo, form, qual, root });
        const tones = new Set(QUALITIES[qual].tones.map(t => (root + t) % 12));
        // positions の pc ⊆ tones / fret 0..16 / (form==='full') === !!barre を確認
      }
    }
```

3. sus4=4度、add9=3度+9度、h79=3度+#9+♭7 など特徴音の存在チェックも入れる(過去にこれで実バグを検出済み)

## 運用ルール

- コミットメッセージは日本語で、変更内容を一行で
- 仕様・デザインの決定を変えたら、対応するドキュメント(CLAUDE.md / DESIGN.md / README.md)も同じコミットで更新する
- デフォルト設定値の変更は、既存ユーザーには localStorage の保存値が優先される点に注意(ユーザーへ案内が必要)
