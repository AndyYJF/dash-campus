-- R1：共享预算账本所需的分类（REPAIR-PLAN §4.2/§4.3）。
-- effort_mode：time_budget 按确认投入扣剩余；deliverable 投入达到估时仍未完成时不再自动补排，需核对剩余。
-- category：只有 study 计入自主学习预算；other（运动、校园事务等）占物理时间但不消耗学习预算。

ALTER TABLE tasks ADD COLUMN effort_mode TEXT NOT NULL DEFAULT 'deliverable' CHECK (effort_mode IN ('deliverable', 'time_budget'));
ALTER TABLE practice_entries ADD COLUMN category TEXT NOT NULL DEFAULT 'study' CHECK (category IN ('study', 'other'));
