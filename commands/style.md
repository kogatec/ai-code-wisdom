---
description: 今の設計スタイルを表示し、主・副スタイル、段階、レビューの設定を変える
argument-hint: "[変えたい内容（例：副スタイルに simple-readable を追加）]"
allowed-tools: Bash(wisdom:*), AskUserQuestion
---

設計スタイルの設定を確認・変更します。

1. `wisdom style` で今の設定を見せる。未設定（「未設定です」と出る）なら、`/ai-code-wisdom:init` を案内して終わる。
2. 変えたい内容が `$ARGUMENTS` にあればそれに従う。なければ、何を変えたいか（主スタイル／副スタイル／段階／レビュー）を AskUserQuestion で聞く。選べるスタイルは `wisdom styles` で確かめる。
3. 変更を実行する。指定した項目だけが変わる。

   ```
   wisdom style set --primary <ID>
   wisdom style set --secondary <ID> --secondary <ID>:0.7
   wisdom style set --secondary none
   wisdom style set --phase prototype
   wisdom style set --review always
   ```

   `--secondary` は副スタイルの一覧を丸ごと置き換える。追加したいときは、今の副スタイルも並べて指定する。
   `--review` は auto（大きな変更の後だけレビュー役を呼ぶ）／always／off。
4. 変更後の有効な原則の数（うち必須）を伝える。必須の原則は、どのスタイルでも外せない。
