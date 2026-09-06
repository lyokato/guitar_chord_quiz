# CLAUDE.md

Guitar Practice Tools。`index.html`(HTML/CSS/JS)を本体とするWebアプリ。音声処理のみAudioWorkletを使い、外部依存・ビルドは不要。
ホーム画面から3つのツールへ遷移する: **コードクイズ**(CHORD QUIZ)、**リズムボックス**(RHYTHM BOX: ドラムパターン付きメトロノーム)、**練習用プレイヤー**(PRACTICE PLAYER: ローカル曲の速度変更・区間ループ)。

## デザインルール(必読)

UIの生成・変更・スタイル調整を行う際は、**必ず先に `DESIGN.md` を読み、そのルールに従うこと。**
色はCSS変数のみ使用し、ボタンの役割体系・レイアウト規則・Do's and Don'ts に反する変更をしない。
デザイン上の新しい決定をしたら `DESIGN.md` を更新すること。

## ファイル構成

- `index.html` — アプリ本体(すべてここ)。単一ファイル構成を維持する。CSS/JSを別ファイルに分割しない
- `pitch-shifter-worklet.js` — キー変更のAudioWorklet。音声スレッド要件による単一ファイル構成の例外。方式・検証方法はtests内のREADMEを参照
- `tests/` — Node.js組み込みテストによる音程・ステレオ・再生経路の回帰検証
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
- SPA風ルーティング: History API(pushState/popstate)で home/title/settings/game/rhythm/player を遷移。ブラウザバックでページを離れない。`switchDom` はRHYTHM BOXまたは練習用プレイヤーの画面を離れるとき、それぞれの再生を自動停止する
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

## PRACTICE PLAYER のアーキテクチャ

- 再生位置・動画表示はネイティブの`<audio>` / `<video playsinline>`を使う。キー変更時は`MediaElementAudioSourceNode`から`pitch-shifter-worklet.js`の`AudioWorkletNode`へ接続し、速度維持のまま−3〜+3半音を処理する。8192サンプルのFFT・512サンプル間隔で各スペクトルピークの実周波数を推定し、周辺の複素スペクトルを位相関係ごと移す。無関係な音の周波数を合成先で平均しない。左右には共通の領域・位相補正を使う。4段階に分割して1コールバックにFFT処理が集中するのを防ぐ。レンダー中にJSの配列・ビューを生成しない。0半音は変換器を通さず原音へ接続する
- ファイル入力は20MB以下。Blob URLで再生し、切り替え時に以前のURLを`URL.revokeObjectURL`で解放する
- 曲データとメタデータはIndexedDB `guitarPracticePlayer`へ保存する。`tracks`は曲名・長さ・範囲・速度・キー・カウント有無/BPM/lag・最終利用日時、`files`はBlobを同じIDで保持する。サーバーへのアップロードや元ファイルパスの保存は行わない
- 履歴は`lastPracticedAt`の降順で最大5曲。各行は容量・長さ・ループ範囲・速度を表示し、曲を再度開くと範囲・速度・キー・カウント設定を復元する。現在の曲の見出し下には容量や「端末内」といった補足を表示しない。Blobが欠落したレコードは開く際に履歴から削除する
- 最近の曲から外す操作はブラウザ標準`confirm()`を使わず、対象名と「最近の曲リストから外す」結果を示すアプリ内`<dialog>`で確認する。UIではファイル削除と誤解させる「削除」を使わない。現在再生中の曲を外した場合は再生を止め、Blob URLを解放してプレイヤーを未選択状態へ戻す。別の曲を外した場合は現在の再生状態を維持する
- シークバーの白いつまみは曲全体の再生位置、オレンジ色の無地マーカーはループ境界を表す。再生つまみの中心と境界線は、左右9pxを除いた`.timeline-scale`の同じ座標系へ置き、`currentTime >= loopEnd`でループする。縦線は約35pxとし、開始マーカーを上、終了マーカーを下へ伸ばして、狭い範囲でも44pxの操作領域同士を重ねない。マーカーと履歴の画面上にA/Bの文字は出さない。各マーカーはポインタードラッグまたは左右キー(Shift併用は1秒)で動かし、開始 ≤ 終了−3秒を常に保つ。3秒未満の曲は全体ループに固定する
- コントロールは3行。1行目は同寸の「ループ先頭へ戻る」「再生/一時停止トグル」を中央配置、2行目は「速度select」「キーselect」、3行目は「カウント」「checkbox」「40〜240のBPM数値入力」「lag」「0.0〜1.0秒の数値入力」を1行で並べる。BPM欄は3桁、lag欄は`0.0`が収まる最小幅にする。範囲リセット、±10秒移動、現在位置から範囲端を設定するボタン、速度rangeは置かない
- カウントは手動で再生を開始するときだけ鳴り、ループ復帰では鳴らない。4/4の2小節で、1小節目の1・3拍、2小節目の1・2・3・4拍へ既存`DRUM_SOUNDS`を予約する。曲は次小節頭からlag秒を引いた時点に再生し、正のlagで先頭無音を相殺する。音源は`preload="auto"`に加え、押下直後にmute状態で`play()`の解決まで待ってから停止・ループ先頭へ戻し、その後カウントを始める。準備中・カウント中の再生ボタンは中止として働き、「カウント中」の状態文は表示しない
- BPM欄は`type="text"` + `inputmode="numeric"` + 数字patternでモバイルの数値キーボードを要求し、`input`時にも数字以外を除去する。40〜240への確定時補正と曲ごとの自動保存は維持する
- ループ境界は`requestAnimationFrame`で監視し、バックグラウンド等への補助として`timeupdate`でも監視する。画面を離れると一時停止する
- IndexedDBへ保存できなくても、読み込み済みの曲は現在セッションで操作できる状態を維持し、履歴だけ利用不可として通知する。非対応コーデックはプレイヤーを未選択状態へ戻してエラーを表示する
- `pitch-shifter-worklet.js`はService Workerの必須キャッシュ対象。プロセッサーのready通知を待ってからメディアを接続し、並行初期化はメディアごとに1本へ集約する。AudioWorkletの初期化失敗または実行時エラーはキーを0へ戻して原音へ接続する。既存の接続でも再生時にはAudioContextをresumeする
- シーク・音源変更・pause・playingでDSPの履歴をresetし、前の音を持ち越さない。変換の遅延は8704サンプル（48kHzで約181ms、44.1kHzで約197ms）で、カウント開始時に報告された遅延分だけメディア再生を早める。キー・速度操作による遷移と実機の音質は聴感確認も必要

## よくある作業レシピ

- **コードタイプ追加**: `QUALITIES` にエントリ追加 → 各 `SHAPES[mode][form]` に定番の押さえ方がある構成だけ定義 → 検証実行。UIは自動追従
- **構成(フォーム)追加**: `FORMS` にキー追加 → 該当SHAPESに定義。1Fシフト除外が必要なら `NO_SHIFT_FORMS` へ
- **プリセット追加**: `LESSON_PRESETS` にエントリ1つ追加するだけ
- **ローコード/オンコード追加**: `LOW_CHORDS` / `ON_CHORDS` に追記(オンコードは5弦/6弦の片方のみ使用ルールを守る)

## 検証(変更後は必ず実行)

`node --test tests/*.test.mjs`で音声処理・再生経路を検証する。音程は曲全体の平均ではなく100msの窓を10msずつ動かして測り、一時的なずれを検出する。

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
