import {
  mapRecord,
  digest,
  recordKey,
  findRemote,
  sameRemote,
} from './solo-records.mjs';
import { soloNativeAttachmentVersion } from './solo-native-attachment.mjs';

// Every remote mutation has a durable pre-write state. An ambiguous create is
// reconciled using SessionID + TurnID; it is never blindly repeated.
export async function syncRecords({
  client,
  rows,
  headers,
  schema,
  ledger,
  save,
  prepareAttachment,
  currentRow,
}) {
  const counts = {
    submitted: 0,
    existing: 0,
    blocked: 0,
    uncertain: 0,
    refreshed: 0,
  };
  ledger.entries ||= {};
  for (const row of rows) {
    const key = recordKey(row);
    let entry = ledger.entries[key];
    const update = (change) => {
      entry = ledger.entries[key] = {
        ...entry,
        taskId: row.taskId,
        turnId: row.turnId,
        ...change,
        updatedAt: new Date().toISOString(),
      };
      save(ledger);
    };
    try {
      if (!row.eligible || row.source !== 'ai') continue;
      const initial = mapRecord(row, headers, schema, [
        { name: 'pending.zip', path: 'pending', size: 1 },
      ]);
      const textData = Object.fromEntries(
        Object.entries(initial.data).filter(([, v]) => !Array.isArray(v)),
      );
      const sourceDigest = digest(textData);
      if (entry?.remoteId) {
        const detail = await client.detail(entry.remoteId);
        if (
          detail.session_id !== initial.data.session_id ||
          detail.turn_id !== initial.data.turn_id
        )
          throw Error('已保存的远端编号与原生标识不一致');
        if (entry.sourceDigest !== sourceDigest) {
          update({
            state: 'local_changed',
            message: '本地内容已变化，保留远端原记录，不自动覆盖',
          });
          counts.blocked++;
          continue;
        }
        if (entry.payload && !sameRemote(detail, entry.payload)) {
          update({
            state: 'conflict',
            message: '远端回读内容与已提交副本不一致，停止自动改写',
          });
          counts.blocked++;
          continue;
        }
        update({
          ...(entry.payload ? { receiptVerified: true } : {}),
          remoteStatus: detail.status,
          qcFinishedAt: detail.qc_finished_at || null,
          qcHitRule: detail.qc_hit_rule || null,
        });
        counts.refreshed++;
        continue;
      }
      const found = await findRemote(client, initial.data);
      if (found.length) {
        if (
          found.length !== 1 ||
          !sameRemote(found[0], entry?.payload || { data: textData })
        ) {
          update({
            state: 'conflict',
            sourceDigest,
            message: '远端同一原生标识存在重复或内容差异，请核对',
          });
          counts.blocked++;
          continue;
        }
        update({
          state: 'existing',
          sourceDigest,
          remoteId: found[0].id,
          remoteStatus: found[0].status,
          message: '远端已存在相同数据，不重复提交',
        });
        counts.existing++;
        continue;
      }
      if (['submitting', 'uncertain'].includes(entry?.state)) {
        update({
          state: 'uncertain',
          message: '上次提交回执不明确，远端暂未查到；停止重发，等待核对',
        });
        counts.uncertain++;
        continue;
      }
      if (entry?.state === 'rejected' && entry.sourceDigest === sourceDigest) {
        counts.blocked++;
        continue;
      }
      const fresh = await currentRow(row);
      if (
        digest(
          Object.fromEntries(
            Object.entries(
              mapRecord(fresh, headers, schema, [
                { name: 'pending.zip', path: 'pending', size: 1 },
              ]).data,
            ).filter(([, v]) => !Array.isArray(v)),
          ),
        ) !== sourceDigest
      )
        throw Error('本地记录在提交前发生变化，下次重新读取');
      const file = await prepareAttachment(row, schema);
      if (
        !file?.bytes ||
        !file.name.endsWith('.zip') ||
        file.status !== 'passed' ||
        file.policyVersion !== soloNativeAttachmentVersion ||
        file.byteIdentical !== true ||
        digest(file.bytes) !== file.sha256
      )
        throw Error('完整轨迹提交副本未通过当前校验');
      const limit = Number(schema.attachment_max_mb || 20) * 1024 * 1024;
      if (!Number.isFinite(limit) || limit <= 0 || file.bytes.length > limit)
        throw Error('轨迹提交包超过平台附件限制');
      if (
        entry?.sourceDigest !== sourceDigest ||
        entry?.attachmentSha256 !== file.sha256
      )
        update({
          state: 'prepared',
          sourceDigest,
          attachmentSha256: file.sha256,
          attachment: null,
        });
      if (!entry?.attachment) {
        update({
          state: 'uploading',
          sourceDigest,
          attachmentSha256: file.sha256,
        });
        const attachment = await client.upload(file);
        if (
          !attachment.path ||
          !attachment.name ||
          Number(attachment.size) !== file.bytes.length
        )
          throw Error('轨迹附件上传回执无效');
        update({
          state: 'uploaded',
          attachment: {
            name: attachment.name,
            path: attachment.path,
            size: attachment.size,
          },
        });
      }
      const latest = await currentRow(row);
      const payload = mapRecord(latest, headers, schema, [entry.attachment]);
      if (
        digest(
          Object.fromEntries(
            Object.entries(payload.data).filter(([, v]) => !Array.isArray(v)),
          ),
        ) !== sourceDigest
      )
        throw Error('附件上传后本地数据变化，停止提交');
      update({
        state: 'submitting',
        sourceDigest,
        payloadDigest: digest(payload),
        payload,
      });
      let result;
      try {
        result = await client.create(payload);
      } catch (error) {
        update({
          state: error.uncertain ? 'uncertain' : 'rejected',
          httpStatus: error.status || null,
          invalidFields: error.fields || [],
          message: error.message,
        });
        if (error.uncertain) counts.uncertain++;
        else counts.blocked++;
        if ([401, 403].includes(error.status)) throw error;
        continue;
      }
      if (!/^\d+$/.test(String(result.id))) {
        update({
          state: 'uncertain',
          message: '平台未返回有效记录编号，停止重发',
        });
        counts.uncertain++;
        continue;
      }
      // Save the ID before a read-back request: a read failure cannot cause a POST replay.
      update({
        state: 'submitted',
        remoteId: result.id,
        remoteStatus: result.status,
        receiptVerified: false,
      });
      const detail = await client.detail(result.id);
      if (!sameRemote(detail, payload)) {
        update({
          state: 'conflict',
          message: '平台已接收，但回读字段存在差异，保留编号待核对',
        });
        counts.blocked++;
        continue;
      }
      update({
        receiptVerified: true,
        remoteStatus: detail.status,
        message: '提交成功，已按原生标识和字段回读核对',
      });
      counts.submitted++;
    } catch (error) {
      // Keep submitting uncertain even if a local failure occurs after the POST.
      update({
        state: entry?.remoteId
          ? entry.state
          : entry?.state === 'submitting'
            ? 'uncertain'
            : 'blocked',
        message: error.message,
      });
      counts.blocked++;
      if ([401, 403].includes(error.status)) throw error;
    }
  }
  ledger.lastRun = { finishedAt: new Date().toISOString(), counts };
  save(ledger);
  return counts;
}
