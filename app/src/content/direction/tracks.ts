/**
 * 工作样本入口（方向页打磨 §4.2）：先讲想解决的问题和平时做什么，专业术语在后。
 * 稳定解释由这里的编辑内容提供；模型只改写解释、结合上下文，不改这里的原文和事实状态。
 * 一个入口可能涉及多个专业方向，不对应唯一职业。
 */

export type TrackTemplate = {
  key: string;
  /** 用一句话说想解决什么问题 */
  title: string;
  problem: string;
  /** 典型实践中经常做的具体活动 */
  activities: string[];
  /** 初学者能看懂的工作样本与产出示例 */
  sample: { steps: string[]; output: string };
  /** 现在需要的基础；needed=false 表示这个试做暂不需要 */
  basics: Array<{ label: string; needed: boolean }>;
  /** 可试做的小项目及它能帮你判断什么 */
  trial: { title: string; verifies: string; firstStep: string; estimateMinutes: number };
  /** 相关的专业方向（说明用，不代表只能走这一条） */
  relatedFields: string[];
};

export const TRACKS: readonly TrackTemplate[] = [
  {
    key: "reliable_agents",
    title: "让智能系统稳定完成任务",
    problem: "Agent 和大模型应用常常这次能做对、下次就出错。这类工作是找出它在哪些情况下会失败，并想办法让它更可靠。",
    activities: ["收集失败的例子", "设计一组固定的测试任务", "比较两种处理方法", "解释为什么一种更好"],
    sample: { steps: ["找 20 个让 Agent 出错的输入", "把错误分成几类", "换一种提示或工具调用方式再试", "比较两种方式各错了几个"], output: "一张失败分类表和一段对比说明" },
    basics: [{ label: "会用 Python 调用一个模型接口", needed: true }, { label: "基本的统计（算比例、看差异）", needed: true }, { label: "深度学习训练", needed: false }],
    trial: { title: "给一个 Agent 做 20 条失败用例并分类", verifies: "你是否喜欢“找问题、做比较、解释原因”这类工作", firstStep: "选一个你常用的 Agent 任务，记下 5 次它做错的情况", estimateMinutes: 45 },
    relatedFields: ["大模型应用", "评测与可靠性", "人机交互"],
  },
  {
    key: "data_quality",
    title: "数据决定模型能做到哪一步",
    problem: "很多模型效果不好，问题出在数据上。这类工作是看懂数据、发现其中的偏差和错误，并让数据更适合任务。",
    activities: ["浏览和统计数据", "找出标注错误或分布不均", "清洗和整理数据", "看改了数据后结果有没有变"],
    sample: { steps: ["下载一个公开小数据集", "统计每一类有多少条", "抽查 50 条看有没有标错", "写下发现的问题"], output: "一份数据检查报告" },
    basics: [{ label: "Python 和表格数据处理", needed: true }, { label: "画简单的统计图", needed: true }, { label: "模型原理", needed: false }],
    trial: { title: "检查一个公开数据集的质量", verifies: "你是否耐得住细看数据、喜欢从数据里发现问题", firstStep: "选一个小数据集，统计每一类的数量", estimateMinutes: 40 },
    relatedFields: ["数据科学", "机器学习"],
  },
  {
    key: "method_compare",
    title: "比较两种方法谁更好、为什么",
    problem: "科研里很常见的工作：同一个问题有不同做法，要公平地比较它们，并说清楚差别从哪来。",
    activities: ["读一篇方法介绍", "复现一个简单结果", "设计公平的对照", "分析实验结果"],
    sample: { steps: ["选两个经典分类算法", "在同一份数据上各跑一次", "换一个参数再跑", "写下哪个更好、可能的原因"], output: "一页实验对比记录" },
    basics: [{ label: "Python 与常用机器学习库", needed: true }, { label: "概率统计", needed: true }, { label: "读英文论文", needed: false }],
    trial: { title: "在一份数据上公平比较两种算法", verifies: "你是否喜欢设计实验、分析结果这类科研工作", firstStep: "装好环境，让第一个算法在小数据上跑通", estimateMinutes: 60 },
    relatedFields: ["机器学习", "科研方法"],
  },
  {
    key: "build_tools",
    title: "把模型做成别人能用的工具",
    problem: "工程方向的日常：把模型能力接进一个真正能用的程序，处理各种边界情况，让别人用得顺手。",
    activities: ["拆需求", "写接口和界面", "调试出错的地方", "收集别人的使用反馈"],
    sample: { steps: ["想一个身边的小需求", "用模型接口做一个最小可用版本", "请一个同学试用", "根据反馈改一处"], output: "一个能演示的小工具和一段改进记录" },
    basics: [{ label: "能写完整的小程序", needed: true }, { label: "会看报错并调试", needed: true }, { label: "模型训练", needed: false }],
    trial: { title: "做一个解决身边小需求的模型小工具", verifies: "你是否喜欢“把东西搭起来、让人用上”这类工程工作", firstStep: "写下需求和最小功能，跑通一次模型调用", estimateMinutes: 50 },
    relatedFields: ["软件工程", "大模型应用"],
  },
  {
    key: "vision",
    title: "让机器看懂图像",
    problem: "计算机视觉关心机器怎样识别和理解图片、视频，比如认出物体、找出位置。",
    activities: ["准备图片数据", "用现成模型做识别", "看它在哪些图上认错", "尝试改进"],
    sample: { steps: ["用一个预训练模型识别 30 张自己拍的照片", "记下认错的图", "猜原因（光线、角度、遮挡）", "换一个模型对比"], output: "一组认错图片和原因分析" },
    basics: [{ label: "Python", needed: true }, { label: "线性代数基础", needed: false }, { label: "GPU 训练环境", needed: false }],
    trial: { title: "用现成模型识别自己的照片并分析错误", verifies: "你是否对图像这类问题有兴趣", firstStep: "跑通一个预训练图像分类模型的示例", estimateMinutes: 45 },
    relatedFields: ["计算机视觉", "机器学习"],
  },
];

export function trackTemplate(key: string): TrackTemplate | undefined {
  return TRACKS.find((t) => t.key === key);
}
