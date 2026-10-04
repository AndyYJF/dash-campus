-- 学习安排上一次按哪个规划修订号对过账：
-- 旧兼容接口（v1 任务/日程编辑）只递增 planning_revision、不触发重排；worker 发现两者不一致就补一次确定性重排。
ALTER TABLE planning_state ADD COLUMN planned_revision INTEGER NOT NULL DEFAULT 0;
-- 现有实例按“已对过账”起步：升级本身不触发一次无缘由的重排
UPDATE planning_state SET planned_revision = planning_revision WHERE id = 1;
