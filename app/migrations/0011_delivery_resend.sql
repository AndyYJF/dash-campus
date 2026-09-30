-- 待修清单 6：unknown / failed 投递由主人显式重发（计划 8.2：新 attempt，提示可能重复）
-- resent_from 指向被重发的原投递；唯一索引保证同一条原投递只能重发一次（重复点击不会发两封）
ALTER TABLE deliveries ADD COLUMN resent_from TEXT REFERENCES deliveries(id);
CREATE UNIQUE INDEX idx_deliveries_resent_from ON deliveries(resent_from) WHERE resent_from IS NOT NULL;
