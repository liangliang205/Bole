# Example：测试简历集

两份用于演示与回归测试的简历压缩包。**全部为造数生成的虚构数据**，姓名、电话、邮箱、公司、项目均非真实信息，可安全公开；不对应任何真实候选人，也不含标注答案（不是 "golden resume"）。

## 内容

| 文件 | 数量 | 格式 | 用途 |
|---|---|---|---|
| `50-resumes-mixed-roles.zip` | 50 份 | 25 PDF + 25 DOCX | 跨 30+ 岗位混合投递（Java、前端、算法、SRE、测试、数据、嵌入式等），用于验证多岗位混投时的画像与扇出 |
| `50-resumes-frontend.zip` | 50 份 | 25 PDF + 25 DOCX | 同一岗位（前端开发工程师）50 人竞争，用于验证同岗批量筛选、Top 40% 短名单与深评 |

解压后目录结构：

```text
mixed-roles/       # 50-resumes-mixed-roles.zip
  万雨桐-性能测试工程师-简历.pdf
  何嘉树-SRE运维开发工程师-简历.docx
  ...
frontend-batch/    # 50-resumes-frontend.zip
  严既白-前端开发工程师-简历.pdf
  于辰-前端开发工程师-简历.pdf
  ...
```

## 用法

解压到任意目录后，用 CLI 跑完整流水线：

```powershell
Expand-Archive .\example\50-resumes-frontend.zip -DestinationPath .\example\
pnpm bole run --jd "招前端开发工程师，3-5 年，base 上海" --files .\example\frontend-batch --yes
```

或在 Web 控制台「新建筛选会话」里直接多选上传解压后的文件。

## 注意

- 100 份简历完整跑一遍会真实消耗模型 token，成本不低。只想验证流程时，建议从 `mixed-roles` 里挑 8 份（正好一批），或先跑 `frontend-batch` 的前 8 份。
- 压缩包内文件均为二进制，Git 无法 diff；改动请直接替换整个压缩包并重新生成，不要手工往压缩包里塞文件。
- 这些简历只覆盖 PDF / DOCX。图片、TXT、超限、伪造文件头等边界样本请自备，不要混入本目录。
