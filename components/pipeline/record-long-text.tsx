import styles from './record-long-text.module.css';

export function RecordLongText({ text }: { text: string }) {
  return (
    <details className={styles.details}>
      <summary>
        <span className={styles.preview}>{text.slice(0, 100)}…</span>
        <span className={styles.collapse}>收起全文</span>
      </summary>
      <pre>{text}</pre>
    </details>
  );
}
