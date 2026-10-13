// All rendering and polling belong to this panel's Cortico context.
const count = value => Number.isFinite(value) ? value.toLocaleString('zh-CN') : '—';
const errorText = value => typeof value === 'string' ? value : value?.message ?? '';
const when = (value, fallback = '暂无') => {
  if (value === null || value === undefined || value === '') return fallback;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value);
  return date.toLocaleString('zh-CN', { hour12: false });
};
const cursorText = cursor => cursor ? `${when(cursor.updatedAt)} · ${cursor.level} · ${cursor.id}` : '等待首次建立';

export default {
  panels: {
    status: {
      mount(ctx) {
        const ui = ctx.ui;
        const sheet = ui.sheet({ title: 'DSH 外部记忆', en: 'MEMORY CHANNEL', desc: '浏览器 DSH 的记忆库、变更通知与会话原文镜像。' });
        const controls = ui.rowbar();
        const status = ui.msgline('正在读取运行状态…');
        const livePill = ui.pill('读取中', 'plain');
        const body = ui.h('div');
        let loading = false;
        let lastCounts = '';

        const statePill = (enabled, configured, error, running, idleLabel) => {
          if (!enabled) return ui.pill('已关闭', 'off');
          if (!configured) return ui.pill('未配置', 'plain');
          if (error) return ui.pill('需要检查', 'off');
          if (!running) return ui.pill('已停止', 'off');
          return ui.pill(idleLabel, 'on');
        };
        const channel = (title, pill, detail, rows, error) => {
          const section = ui.h('div');
          const heading = ui.rowbar();
          heading.append(ui.section(title, detail), pill);
          section.append(heading, ui.kv(rows));
          if (error) section.append(ui.msgline(errorText(error), true));
          return section;
        };

        const refresh = async () => {
          if (loading || ctx.signal.aborted) return;
          loading = true;
          try {
            const s = await ctx.invoke('snapshot');
            if (ctx.signal.aborted) return;
            const reader = s.reader;
            const watch = s.watch;
            const write = s.write;
            const raw = s.raw;
            const workspace = s.sourceMode === 'workspace';
            const files = s.files ?? { enabled: false, roots: [] };
            const currentError = errorText(s.lastError) || errorText(reader.error) || errorText(s.workspace?.error) || (files.enabled ? errorText(files.error) : '') || (write.enabled ? errorText(write.error) : '') || (raw.enabled ? errorText(raw.error) : '');
            const watchError = workspace ? '' : errorText(watch.error) || (!reader.error && !write.error && !raw.error ? errorText(s.lastError) : '');
            const label = currentError ? '需要检查' : s.running ? '运行中' : '已停止';
            livePill.textContent = label;
            livePill.className = ui.pill(label, currentError || !s.running ? 'off' : 'on').className;
            status.textContent = currentError ? `当前故障：${currentError}` : s.running ? workspace ? '工作区资料通道运行中；按授权 cwd 同步会话，项目文件只按需读取。' : '通道运行中；没有新条目或待写入内容时为正常空闲。' : 'World 已停止。';
            status.classList.toggle('bad', !!currentError);

            const nodes = [
              ui.statgrid([
                { k: '可见记忆', v: count(reader.counts?.total) },
                { k: '原文轮次', v: count(raw.totalTurns) },
                { k: watch.trigger === 'record' ? '已记录变更' : '已保存通知', v: count(watch.trigger === 'record' ? watch.recordedChanges?.total ?? 0 : s.counters.pushedEvents), accent: true },
                { k: '本通道已入库', v: count(s.counters.writtenRows) },
              ]),
              ...(workspace ? [channel('工作区来源范围', statePill(true, !!s.scope?.workspaceRoots?.length, s.workspace?.error, s.running, '范围就绪'), '校验授权根目录；会话归属由原文通道逐个检查 session.cwd', [
                { k: '允许工作区', v: s.scope?.workspaceRoots?.join(' · ') || '未配置' },
                { k: '禁止路径', v: s.scope?.workspaceDenied?.join(' · ') || '未设置额外禁止路径' },
                { k: '最近范围检查', v: when(s.workspace?.lastCheckedAt) },
                { k: '数据库', v: 'workspace 模式不使用记忆库，不写回' },
              ], s.workspace?.error)] : []),
              channel('记忆库读取', statePill(!workspace, !!reader.dbFile && reader.state !== 'unconfigured', reader.error || reader.state === 'error', s.running, '就绪'), workspace ? 'workspace 模式已停用记忆库功能' : '查询与数据库连接状态', [
                { k: '数据库', v: reader.dbFile || '未配置' },
                { k: '最近读取检查', v: when(reader.lastCheckedAt, '等待首次检查') },
                { k: '来源最近更新', v: when(reader.latestUpdatedAt) },
                { k: '各层条目', v: reader.counts ? Object.entries(reader.counts.byLevel ?? {}).map(([level, total]) => `${level} ${count(total)}`).join(' · ') || '暂无条目' : '等待统计' },
              ], reader.error),
              channel('记忆变更', statePill(watch.enabled, !!reader.dbFile, watchError, s.running, watch.pendingDelivery ? '等待重试' : watch.trigger === 'record' ? '只记录' : '正常空闲'), watch.enabled ? `每 ${watch.intervalSeconds} 秒检查记忆库${watch.trigger === 'record' ? '；不唤醒模型' : ''}` : '可在配置页启用', [
                { k: '最近检查', v: when(watch.lastPollAt, watch.enabled ? '等待首次检查' : '已关闭') },
                { k: '最近成功', v: when(watch.lastSuccessAt) },
                { k: watch.trigger === 'record' ? '累计记录 / 来源分组' : '最近确认通知', v: watch.trigger === 'record' ? `${count(watch.recordedChanges?.total ?? 0)} / ${count(watch.recordedChanges?.groupCount ?? 0)}` : when(watch.lastPushAt) },
                { k: '待投递批次', v: watch.pendingDelivery ? '1' : '0' },
                { k: '已确认位置', v: cursorText(watch.cursor) },
              ], watchError),
              channel('记忆入库', statePill(write.enabled, !!reader.dbFile, write.error, s.running, write.pending > 0 ? '等待入库' : '正常空闲'), write.enabled ? write.flushSeconds > 0 ? `每 ${write.flushSeconds} 秒冲刷队列` : '收到写入请求时立即入库' : '当前关闭写入', [
                { k: '待入库条目', v: count(write.pending) },
                { k: '已入库条目', v: count(write.writtenRows) },
                { k: '最近尝试', v: when(write.lastAttemptAt) },
                { k: '最近成功入库', v: when(write.lastWriteAt, '暂无写入样本') },
              ], write.error),
              channel('会话原文镜像', statePill(raw.enabled, !!raw.sessionsDir && !!raw.rawDir, raw.error || raw.scrubMismatch, s.running, '就绪'), raw.enabled ? raw.intervalSeconds > 0 ? `每 ${raw.intervalSeconds} 秒增量同步` : '按需同步' : '当前关闭原文镜像', [
                { k: '会话源目录', v: raw.sessionsDir || '未配置' },
                { k: '镜像目录', v: raw.rawDir || '未配置' },
                { k: '最近同步尝试', v: when(raw.lastSyncAt) },
                { k: '最近成功同步', v: when(raw.lastSuccessAt, '暂无同步样本') },
                { k: '最近新增轮次', v: raw.lastResult ? count(raw.lastResult.newTurns) : '暂无同步样本' },
                { k: '本次达到上限', v: raw.lastResult ? raw.lastResult.capped ? '是；余量留待后续同步' : '否' : '暂无同步样本' },
                { k: '清洗规则', v: raw.scrubMismatch ? '现有镜像与当前清洗版本不一致' : '当前未发现版本不一致' },
              ], raw.error),
            ];

            if (files.enabled) nodes.push(channel('项目文件', statePill(true, !!files.roots?.length, files.error, s.running, '按需只读'), 'list / read / search；不自动监听项目文件或触发模型', [
              { k: '允许根目录', v: files.roots.join(' · ') },
              { k: '单文件预算', v: `${count(files.maxFileBytes)} 字节` },
              { k: '默认排除', v: '隐藏目录、凭据、二进制、构建产物、源会话与备份' },
            ], files.error));

            if (raw.buckets?.length) {
              const table = ui.table({ head: ['工作区', '原文轮次', '日期文件', '来源最近日期'] });
              for (const bucket of raw.buckets) table.addRow([bucket.bucket, count(bucket.turns), count(bucket.days), bucket.latest || '暂无']);
              nodes.push(ui.section('原文范围'), table.el);
            }
            nodes.push(
              ui.section('运行证据'),
              ui.kv([
                { k: '累计检查', v: count(s.counters.polls) },
                { k: '已通知记忆条目', v: count(s.counters.pushedItems) },
                { k: '本地记录变更', v: count(watch.recordedChanges?.total ?? 0) },
                { k: '工具读取', v: count(s.counters.toolReads) },
                { k: '累计故障', v: count(s.counters.failures) },
                { k: '最近历史故障', v: s.lastFailure ? `${when(s.lastFailure.at)}${s.lastFailure.component ? ` · ${s.lastFailure.component}` : ''} · ${errorText(s.lastFailure)}` : '暂无' },
                { k: '桥接日志', v: s.runtime.logDir || '未配置' },
                { k: '恢复文件', v: s.runtime.checkpointFile || '未配置' },
              ]),
              ui.msgline('记录变更只表示 World 已保存来源元数据；通知计数表示 Core 已保存事件。两者均不表示用户已收到汇报。累计故障保留历史记录。'),
            );
            body.replaceChildren(...nodes);
            const counts = [s.counters.polls, s.counters.pushedEvents, s.counters.pushedItems, s.counters.writtenRows, s.counters.failures, s.counters.toolReads, reader.counts?.total, raw.totalTurns, write.pending, watch.recordedChanges?.total ?? 0].join(':');
            if (counts !== lastCounts) { await ctx.refresh(); lastCounts = counts; }
          } catch (error) {
            if (!ctx.signal.aborted) {
              status.textContent = `状态读取失败：${error instanceof Error ? error.message : String(error)}`;
              status.classList.add('bad');
              livePill.textContent = '读取失败';
              livePill.className = ui.pill('读取失败', 'off').className;
            }
          } finally { loading = false; }
        };
        controls.append(ui.button('刷新状态', { onClick: () => { void refresh(); } }), livePill, ui.pill('外部来源', 'plain'));
        sheet.body.append(controls, status, body);
        ctx.root.append(sheet.el);
        void refresh();
        ctx.interval(() => { void refresh(); }, 5000);
      },
    },
  },
};
