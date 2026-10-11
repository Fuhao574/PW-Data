/** 固定目标集文件事务。不是跨目录原子 rename：通过日志、旧备份和下次启动恢复保持可恢复性。 */
import fs from 'node:fs/promises';
import path from 'node:path';
const exists = async p => { try { await fs.lstat(p); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } };
async function noSymlink(p) { if (await exists(p) && (await fs.lstat(p)).isSymbolicLink()) throw new Error(`refuse symlink: ${p}`); }
export async function withTransaction(root, names, prepare, { stateName = '.data-transaction', checkpoint = async () => {} } = {}) {
  if (names.some(n => !/^[A-Za-z0-9.-]+$/.test(n) || n === '.' || n === '..') || new Set(names).size !== names.length) throw new Error('invalid transaction targets');
  if (!/^\.[a-z-]+$/.test(stateName)) throw new Error('invalid transaction state');
  root = path.resolve(root); await fs.mkdir(root, { recursive: true });
  const state = path.join(root, stateName), lock = state + '-lock';
  await noSymlink(state); await noSymlink(lock);
  try { await fs.mkdir(lock); } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    // 串行接管死 PID 锁，避免两次恢复同时删掉对方新建的活锁。
    const reclaim = lock + '-reclaim';
    await noSymlink(reclaim);
    try { await fs.mkdir(reclaim); } catch { throw new Error('another recovery is running; inspect lock manually if stale'); }
    try {
    const pid = Number(await fs.readFile(path.join(lock, 'pid'), 'utf8').catch(() => ''));
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('transaction lock has no valid owner; inspect manually');
    try { process.kill(pid, 0); throw new Error('another data build/sync is running'); }
    catch (err) { if (err.code !== 'ESRCH') throw err; }
    await fs.rm(lock, { recursive: true }); await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, 'pid'), String(process.pid));
    } finally { await fs.rm(reclaim, { recursive: true, force: true }); }
  }
  await fs.writeFile(path.join(lock, 'pid'), String(process.pid));
  const stage = path.join(state, 'stage'), backup = path.join(state, 'backup'), journal = path.join(state, 'journal.json');
  const recover = async () => {
    if (!(await exists(journal))) { await fs.rm(state, { recursive: true, force: true }); return; }
    const record = JSON.parse(await fs.readFile(journal, 'utf8'));
    if (JSON.stringify(record.names) !== JSON.stringify(names) || !Array.isArray(record.had) || record.had.length !== names.length || record.had.some(v => typeof v !== 'boolean') || typeof record.committed !== 'boolean') throw new Error('invalid transaction journal; inspect manually');
    if (!record.committed) for (let i = 0; i < names.length; i++) {
      const live = path.join(root, names[i]), old = path.join(backup, names[i]);
      await noSymlink(live); await noSymlink(old);
      if (await exists(old)) { await fs.rm(live, { recursive: true, force: true }); await fs.rename(old, live); }
      else if (!record.had[i]) await fs.rm(live, { recursive: true, force: true });
    }
    await fs.rm(state, { recursive: true, force: true });
  };
  try {
    await recover();
    for (const n of names) await noSymlink(path.join(root, n));
    await fs.mkdir(stage, { recursive: true }); await fs.mkdir(backup);
    await prepare(stage);
    for (const n of names) { if (!(await exists(path.join(stage, n)))) throw new Error(`missing staged target ${n}`); await noSymlink(path.join(stage, n)); }
    const record = { names, had: await Promise.all(names.map(n => exists(path.join(root, n)))), committed: false };
    await fs.writeFile(journal + '.next', JSON.stringify(record)); await fs.rename(journal + '.next', journal);
    for (const n of names) {
      const live = path.join(root, n);
      if (await exists(live)) await fs.rename(live, path.join(backup, n));
      await checkpoint('backup', n);
      await fs.rename(path.join(stage, n), live);
      await checkpoint('install', n);
    }
    record.committed = true;
    await fs.writeFile(journal + '.next', JSON.stringify(record)); await fs.rename(journal + '.next', journal);
    await checkpoint('committed'); await fs.rm(state, { recursive: true, force: true });
  } catch (e) { await recover(); throw e; }
  finally { await fs.rm(lock, { recursive: true, force: true }); }
}
