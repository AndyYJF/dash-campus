import BlockerAssist from "./BlockerAssist";
import Icon from "./Icon";
import styles from "./dash.module.css";
import LogEdit from "./LogEdit";

type LogLite = { id: string; occurredOn: string; progress: string; blocker: string; projectId: string | null };

/** 记录时间线：日期、进展、卡点（带"分析这个卡点"入口）。今天页与项目页共用。 */
export default function LogTimeline({ logs,onChanged }: { logs: LogLite[];onChanged?:()=>void }) {
  return (
    <div className={styles.timeline}>
      {logs.map((log) => (
        <div key={log.id} className={styles.timelineItem}>
          <div className={styles.timelineDate}>{log.occurredOn}</div>
          {log.progress && <div>{log.progress}</div>}
          {log.blocker && (
            <div className={styles.timelineBlocker}>
              <Icon name="alert" size={15} />
              <span>卡点：{log.blocker}</span>
            </div>
          )}
          <BlockerAssist log={log} />
          {onChanged&&<LogEdit id={log.id} onChanged={onChanged}/>}
        </div>
      ))}
    </div>
  );
}
