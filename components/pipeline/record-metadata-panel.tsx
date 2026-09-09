'use client';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { roundNumber, type RecordMetadata } from '@/lib/record-metadata';
import type { Task, Turn } from '@/lib/pipeline';
export function RecordMetadataPanel({
  task,
  turn,
  run,
  busy,
}: {
  task: Task;
  turn: Turn;
  run: (body: object) => Promise<boolean>;
  busy: boolean;
}) {
  const [value, setValue] = useState<RecordMetadata>(
    turn.recordMetadata || {
      parentRecord: '',
      auditNote: '',
      parentRecord2: '',
    },
  );
  const locked =
    !['review', 'failed'].includes(turn.status) ||
    !!turn.receipt ||
    !!turn.humanReview?.receipt;
  return (
    <details className="section">
      <summary>审核与关联字段 · 第 {roundNumber(task, turn)} 轮</summary>
      <p className="sub">
        轮次排序在会话内固定，筛选和导出不重新编号；两个父记录字段按外部平台的实际关联填写，没有关联时留空。
      </p>
      <div className="formgrid">
        {(
          [
            ['parentRecord', '父记录'],
            ['parentRecord2', '父记录 2'],
          ] as const
        ).map(([key, label]) => (
          <label className="field" key={key}>
            {label}
            <input
              value={value[key]}
              maxLength={2000}
              disabled={locked || busy}
              onChange={(e) => setValue({ ...value, [key]: e.target.value })}
            />
          </label>
        ))}
        <label className="field wide">
          审核备注
          <textarea
            rows={3}
            maxLength={5000}
            value={value.auditNote}
            disabled={locked || busy}
            onChange={(e) => setValue({ ...value, auditNote: e.target.value })}
          />
        </label>
      </div>
      <Button
        disabled={locked || busy}
        onClick={() =>
          run({ action: 'record-metadata', turnId: turn.id, metadata: value })
        }
      >
        保存审核字段
      </Button>
      <p className="sub">
        {locked
          ? '执行中或已登记交付的轮次不能修改。'
          : '修改会保留历史，保存备注不等于通过人工复核。'}
      </p>
      {!!turn.metadataHistory?.length && (
        <details>
          <summary>查看修改历史（{turn.metadataHistory.length}）</summary>
          {turn.metadataHistory.map((h, i) => (
            <div key={i}>
              <p className="sub">{h.at}</p>
              <pre className="sub">
                {JSON.stringify(
                  { 修改前: h.previous, 修改后: h.value },
                  null,
                  2,
                )}
              </pre>
            </div>
          ))}
        </details>
      )}
    </details>
  );
}
