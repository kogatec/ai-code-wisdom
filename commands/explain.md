---
description: 原則の理由・検査の方法・良い例と悪い例を説明する
argument-hint: "<原則ID（例：SEC-INJ-002）>"
allowed-tools: Bash(torus:*)
---

`torus explain $ARGUMENTS` を実行し、結果をもとに説明してください。

- ID が指定されていないときは、`torus principles` で有効な原則の一覧を見せ、どれを知りたいか聞く。
- 説明では、原則の理由、この原則が当てはまらない場合、静的検査とレビューの観点、良い例と悪い例を、短くまとめる。
- 今のコードに関係する場合は、該当箇所をどう直すかも添える。
