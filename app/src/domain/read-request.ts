/** A read request must be admitted before any task/material classification. */
export function isReadRequest(text: string): boolean {
  const value = text.trim().replace(/[。！!？?]+$/, "");
  if (/^(?:你)?(?:(?:请|麻烦|帮我|给我|能不能|能否|可以|我想|我想要|我想请你|帮忙|让我)\s*)*(?:看(?:一下|下|看)|查看|查询|查(?:一下|下)|显示|列出|展示|告诉我|请问)/.test(value)) return true;
  // These prefixes explicitly ask to perform/remember work, even when its name includes 查看.
  if (/^(?:请|帮我|麻烦)?(?:创建|新增|添加|新建|安排|提醒|记录|导入|修改|调整|把|将)|^(?:我(?:要|想|准备|打算)|明天(?:要|准备|打算))/.test(value)) return false;
  return /^(?:我|我的|目前|当前|现在|最近|今天|明天|后天|本周|这周|下周|每天|这|为什么|怎么|还有)/.test(value) && /(?:安排|课表|课程|时间|空档|任务|待办|项目|方向|目标|进展|状态|预算|规则|作息|提醒|学了|做了)/.test(value) && /(?:有哪些|哪些|有多少|多少|多久|如何|怎么样|是什么|在哪|哪里|怎么|为什么|有没有|是否|吗|呢)/.test(value);
}
