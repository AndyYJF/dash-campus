/**
 * 四年通用阶段模板（方向页打磨 §4.1）。可调整的编辑内容，不是任何学校的官方培养方案；
 * 不写成绩、竞赛、论文、导师或申请的硬指标——正式政策与日期只来自主人资料或可核对来源。
 * 阶段内容可以提前、延期或跳过，不据此给主人贴“落后”标签。
 */

export const STAGE_KEYS = ["year1", "year2", "year3", "year4"] as const;
export type StageKey = (typeof STAGE_KEYS)[number];

export const PATH_KEYS = ["research", "further_study", "employment", "undecided"] as const;
export type PathKey = (typeof PATH_KEYS)[number];

export const PATH_LABEL: Record<PathKey, string> = {
  research: "科研",
  further_study: "继续深造",
  employment: "工程与就业",
  undecided: "还没想好",
};

export type StageTemplate = {
  key: StageKey;
  label: string;
  title: string;
  /** 这一阶段想得到什么 */
  purpose: string;
  /** 共同基础 */
  foundations: string[];
  /** 值得验证的选择 */
  choices: string[];
  /** 可以留下的成果（可观察） */
  outputs: string[];
  /** 下一阶段可能需要什么 */
  nextNeeds: string[];
  /** 去向叠加提示：共同基础优先，只说可验证的活动，不给硬指标 */
  pathHints: Partial<Record<Exclude<PathKey, "undecided">, string>>;
};

export const STAGES: readonly StageTemplate[] = [
  {
    key: "year1",
    label: "大一",
    title: "建立基础和感知",
    purpose: "对专业里的人平时做什么有初步认识，同时把数学和编程的底子打起来。",
    foundations: ["数学课（微积分、线性代数）的学习记录", "能独立写完一个小程序"],
    choices: ["先看两三类工作的样子，挑一个试一次"],
    outputs: ["一次能讲清过程的小实验或小程序", "一段自己的感受：喜欢哪部分、卡在哪"],
    nextNeeds: ["知道自己更想比较哪几类工作"],
    pathHints: {
      research: "先体验一次“提出问题→做实验→解释结果”，不急着选研究领域。",
      further_study: "先把基础课学扎实，具体要求等有可核对的资料再看。",
      employment: "先做一个能跑起来、别人能用的小工具。",
    },
  },
  {
    key: "year2",
    label: "大二",
    title: "比较与验证",
    purpose: "通过不同的工作样本，分清哪些是兴趣、哪些是基础欠缺、哪些只是暂时的困难。",
    foundations: ["概率统计、数据结构", "能读懂并复现一段别人的代码"],
    choices: ["比较两种方法或两类工作，再决定先往哪边多投一点"],
    outputs: ["一次复现或工程小项目", "一份失败分析：哪里没做出来、为什么"],
    nextNeeds: ["一个愿意持续做一段时间的方向"],
    pathHints: {
      research: "做一次方法比较或复现，看自己是否喜欢分析实验结果。",
      further_study: "继续记录课程与实践；联系老师等线索由你自己记录。",
      employment: "做一个完整的小系统，体验需求、调试和交付。",
    },
  },
  {
    key: "year3",
    label: "大三",
    title: "深入投入",
    purpose: "有限地聚焦，持续完成一段较完整的工作。",
    foundations: ["和所选方向直接相关的课程与工具"],
    choices: ["按你确认的去向和真实要求，补这一阶段的目标"],
    outputs: ["迭代过几轮的项目", "别人能复查的成果", "你自己的复盘"],
    nextNeeds: ["能拿来说明自己做过什么的材料"],
    pathHints: {
      research: "围绕一个问题持续做，记录每次实验的想法和结果。",
      further_study: "具体的申请要求以你记录的正式资料为准。",
      employment: "把项目做到有人真正在用，记下解决过的问题。",
    },
  },
  {
    key: "year4",
    label: "大四",
    title: "整理成果与下一步",
    purpose: "把已有实践整理出来，用在自己的下一步选择上。",
    foundations: ["已有项目与记录"],
    choices: ["按自己的去向整理材料"],
    outputs: ["作品说明", "研究或工程总结", "个人材料"],
    nextNeeds: [],
    pathHints: {
      research: "整理研究过程与结论。",
      further_study: "申请、毕业等具体节点来自你的资料或可核对来源。",
      employment: "整理能展示能力的项目说明。",
    },
  },
];

export function stageTemplate(key: StageKey): StageTemplate {
  return STAGES.find((s) => s.key === key)!;
}
