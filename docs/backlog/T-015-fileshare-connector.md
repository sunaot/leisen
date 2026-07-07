# T-015: ファイル共有コネクタ(SMB/NFS上のOffice・PDF)

## 位置づけ
index-requiredクラス(ADR-007)。検索層(Q3)なしでは成立しないため、着手は検索層モジュール後。ただしIF検証はfittingテストで完了済み。

## 未確定の前提(Q3までに要決着)
- delegated_identity credentialの具体方式(Kerberos制約付き委任 等)— ADR必須
- Office/PDFのテキスト抽出とページアンカー付与の実装方式

## 受け入れ条件(骨子)
- [ ] 認可が「本人としてのアクセス試行」で行われ、ACL外ファイルがヒットに現れない
- [ ] PDF/OfficeのヒットがHitAnchor(page)を返し、fetchがページ単位で本文を返す

## 更新(2026-07-05)
delegated_identityの方式検証はT-017(Q2スパイク)に前倒しされた。本タスクの「未確定の前提」はT-017の成果ADRで解消してから着手する。
