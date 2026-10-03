# A01–A22 验收映射（2026-10-03）

每项标注：✅ 已有自动化行为测试（给文件）/ 🟡 部分覆盖（说明缺口）/ ❌ 未覆盖（说明保留方案）。
"测试必须验证行为，不镜像实现"——以下均引用真实行为断言，无静态代码断言。

## 主链路（P1–P3 已建）

| ID | 状态 | 证据 |
|---|---|---|
| A01 文字课表缺首周 | ✅ | `intake-v2.test.ts` A04/A01：资料已存、只 1 个 open 问题、未编日期 |
| A02 回答当前第五周 | ✅ | `intake-v2.test.ts` A02/A11：锚点 2026-08-31 正确；同 revision 由 snapshotRevision 测试覆盖（pages-v2） |
| A03 离散周/单日停课 | ✅ | 离散周：SDCT1 weeks 解析（P1 起）；停课例外：`acceptance-v2.test.ts` A03（例外→eventsForDay 排除→撤销恢复） |
| A04 混合通知和记录 | ✅ | `intake-v2.test.ts` A04：混合文字拆多 item 独立推进 |
| A05 已知 2h 任务 | ✅ | `pages-v2.test.ts`：120min 任务排出 90+30 合法块，不超预算；线上 P3 冒烟复核 |
| A06 deadline 前做不完 | ✅ | `pages-v2.test.ts`：unscheduled 明确报 deadline_unfeasible，真实 deadline 不改 |
| A07 未确认作息 | ✅ | `pages-v2.test.ts` + 前端"暂定"badge + 一句话确认接口 |
| A08 记录40分钟且已有计时 | 🟡 | 手动汇报双计防护：同文字不同日期各算一条（P4 测试）。"已有计时"前提不存在——focus_sessions 未实现，无双计风险。保留：实现计时器时需同测合并 |
| A09 修改今天锁定块 | ✅ | `acceptance-v2.test.ts` A09：锁定块重排后保留原位不被 supersede |
| A10 模型失败/缺配置 | ✅ | `intake-v2.test.ts` A10：原文保留、事项 failed、retry 后恢复；真实模型 e2e 复核（excerpt 校验拒过编造） |
| A11 回答后重启/租约失效 | ✅ | `intake-v2.test.ts` A02/A11：答案恢复不重复调模型；lease fencing 由 jobs 测试覆盖 |
| A12 同源重放/新 revision | ✅ | 幂等键重放 200/409（intake-v2 幂等测试）；blob hash 去重（P4）；undo tombstone（P2） |
| A13 撤销后有后续修改 | ✅ | `commands-items-v2.test.ts`：owner 编辑后 undo 409 不覆盖 |
| A14 图片与扫描 PDF | 🟡 | 图片走 vision（P4 测试+真实端点探测）；PDF 明确失败保原文。缺口：vision 返回文本无坐标/页号；fixture 模式 integration_mode 显式标注已有 |
| A15 XLSX/ICS 不支持字段 | ✅ | ICS 子集准确+RRULE 跳过计数不静默丢（P4 测试）；XLSX 明确失败 |
| A16 URL 私网/超限 | ✅ | `acceptance-v2.test.ts` A16：私网/环回/链路本地主动拒绝，重定向逐跳校验；超限 413/422（P4 测试） |
| A17 恶意指令 | ✅ | `acceptance-v2.test.ts` A17：DROP TABLE 文本投递后表仍在、原文保存；架构上模型输出无执行路径 |
| A18 新库恢复/重建 epoch | ✅ | `scripts/dev/restore-drill.ts`：checkpoint→拷贝→blob hash 校验→表结构/hold 列验证；hold 不发外部请求由 v1 恢复测试保留 |
| A19 Todo 保护 | ✅ | V2 零 Todo 写路径（代码可审计）；v1 桥接只读；0021 迁移事故未触及 Todo 数据 |
| A20 320/390px、桌面、键盘 | 🟡 | 三页 CSS 用流式布局无固定宽度；未做自动化视口测试。保留：人工走查一次（见下） |
| A21 首次进入/七天使用 | 🟡 | 首周问题最多 1 个 open（全局共享 question_key）；偏好一句话确认。"初次一组 3 个关键偏好问题"未做成引导组——以 semester 问题+暂定偏好顶替，差距记录 |
| A22 邮件 | ✅ | 复用 v1 投递（安静时段/去重/unknown 不重发均有 v1 测试）；周事实同一 weekFacts 函数供邮件，页面用 snapshot 同源 DB 事实 |

## 已知限制汇总（不掩盖）

1. **focus_sessions 计时器**未实现（A08 前提缺失，无双计风险；P3 已记录）。
2. **PDF/XLSX 解析**需新 npm 依赖，未获批准前明确失败保原文（A14/A15 以失败路径覆盖）。
3. **vision 无坐标/页号**：模型只返回文本（A14 缺口）。
4. **A20 响应式**无自动化证据，需一次人工走查。
5. **A21 偏好引导组**未实现，以单问题+暂定偏好顶替。
6. **域名→私网 DNS 防护**未做（A16 已拦 IP 字面量；单用户自托管由用户自己提供 URL，风险有限）。

## 切换与旧界面退休（P6）

- /today 已是 V2 视图（P3）；导航移除 v1「计划」页入口（保留 explore/inbox/reviews——V2 未覆盖其功能）。
- v1 写路径未删除，与新命令并存（兼容入口，P2 退出条件允许）。
- 生产数据：v1 tasks 243 条等保持只读兼容，未回灌未改写。
