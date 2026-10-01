import styles from "./dash.module.css";

/** 时长的大字写法：数字用数值字号，单位用小字（"5 小时 15 分"）。放在 .stripValue 里用。 */
export default function Duration({ minutes }: { minutes: number }) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) {
    return (
      <>
        {m}
        <span className={styles.stripUnit}>分钟</span>
      </>
    );
  }
  return (
    <>
      {h}
      <span className={styles.stripUnit}>小时</span>
      {m > 0 && (
        <>
          {m}
          <span className={styles.stripUnit}>分</span>
        </>
      )}
    </>
  );
}
