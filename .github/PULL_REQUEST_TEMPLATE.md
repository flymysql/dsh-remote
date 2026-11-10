<!-- 谢谢你的 PR！这几条是本仓库用教训换来的，勾完再标 Ready。 -->

## 这是什么

<!-- 一句话：这个 PR 改什么、为什么。关联 issue 用 "Fixes #123"。 -->

## 自检清单

- [ ] `npm test` 全绿（含新增的回归测试——修复必须有「没它就会复发」的测试）
- [ ] `node check.mjs` 通过
- [ ] 行尾：代码文件 LF（**不要**用 PowerShell 的 Set-Content/Out-File 重写代码文件，会引入 CRLF）
- [ ] README 双语同步改了的话 `node --test test/readme-parity.test.js` 通过
- [ ] 不带版本号与 CHANGELOG（发布流程统一处理）

## 验证

<!-- 你怎么验证的：单测/真机/截图。宿主行为假设请注明出处（bundle 行号/文档）。 -->
