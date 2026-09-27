(function() {
  var statusEl = document.getElementById('monitor-status');
  var cardsEl = document.getElementById('global-cards');
  var routeBody = document.querySelector('#route-table tbody');
  var channelBody = document.querySelector('#channel-table tbody');
  var trendBars = document.getElementById('trend-bars');
  var samples = [];
  var timer = null;
  var expandedChannels = {};
  var expandedModels = {};
  var controllingChannel = null;

  function effectiveState(record, channel) {
    if (!record) return null;
    if (channel && (channel.manualRemainingSeconds > 0 || channel.quotaRemainingSeconds > 0)) return 'open';
    return channel && channel.disableCooldown ? 'closed' : record.state;
  }

  function manualBadge(record) {
    return record && record.manualRemainingSeconds > 0
      ? '<span class="quota-badge">人工熔断 ' + escapeHtml(record.manualRemainingSeconds) + 's</span>' : '';
  }

  function escapeHtml(value) {
    var div = document.createElement('div');
    div.textContent = value == null ? '' : String(value);
    return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtTime(value) {
    return value ? new Date(value).toLocaleTimeString() : '-';
  }

  function stateClass(state) {
    return state === 'closed' ? 'state-ok' : state === 'half_open' ? 'state-warn' : state === 'open' ? 'state-bad' : '';
  }

  function stateLabel(state) {
    if (state === 'closed') return '正常';
    if (state === 'half_open') return '半开';
    if (state === 'open') return '熔断';
    if (state === 'idle') return '无数据';
    return '—';
  }

  function stateBadge(state) {
    return '<span class="state-badge ' + stateClass(state) + '">' + escapeHtml(stateLabel(state)) + '</span>';
  }

  function cooldown(record) {
    var remainingSeconds = Number(record && record.remainingSeconds) || 0;
    return remainingSeconds > 0 ? remainingSeconds + 's' : '-';
  }

  function fmtQuotaRemaining(seconds) {
    var s = Number(seconds) || 0;
    if (s <= 0) return '';
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    if (h > 0) return h + 'h' + (m > 0 ? m + 'm' : '');
    if (m > 0) return m + 'm';
    return s + 's';
  }

  function quotaBadge(record) {
    var seconds = Number(record && record.quotaRemainingSeconds) || 0;
    if (seconds <= 0) return '';
    return '<span class="quota-badge" title="上游报告额度耗尽，冷却结束前跳过该渠道（最近一次额度失败：' + fmtTime(record.lastQuotaFailureAt) + '，累计额度失败：' + statCount(record.quotaFailureCount) + '）">额度 ' + escapeHtml(fmtQuotaRemaining(seconds)) + '</span>';
  }

  function channelQuotaRemaining(snapshot, channelId) {
    var record = (snapshot.channels || []).find(function(entry) {
      return entry.channelId === channelId;
    });
    return Number(record && record.quotaRemainingSeconds) || 0;
  }

  function channelQuotaRecord(snapshot, channelId) {
    return (snapshot.channels || []).find(function(entry) {
      return entry.channelId === channelId;
    }) || null;
  }

  function statCount(value) {
    var count = Number(value);
    return Number.isFinite(count) && count >= 0 ? count : 0;
  }

  function requestStats(record) {
    if (!record) {
      return {
        attempts: '<span class="stat-empty">-</span>',
        split: '<span class="stat-empty">-</span>',
        rate: '<span class="stat-empty">-</span>',
      };
    }
    var successes = statCount(record.successCount);
    var failures = statCount(record.totalFailures);
    var attempts = successes + failures;
    var rate = attempts > 0 ? ((successes / attempts) * 100).toFixed(1) + '%' : '-';
    return {
      attempts: '<span class="stat-attempts">' + escapeHtml(attempts) + '</span>',
      split: '<span class="stat-split"><span class="stat-success">' + escapeHtml(successes) + '</span>' +
        '<span class="stat-divider"> / </span><span class="stat-failure">' + escapeHtml(failures) + '</span></span>',
      rate: '<span class="' + (attempts > 0 ? 'stat-rate' : 'stat-empty') + '">' + escapeHtml(rate) + '</span>',
    };
  }

  function breakerStat(record) {
    if (!record) return '<span class="stat-empty">-</span>';
    var rate = record.windowFailureRate == null ? '-' : (record.windowFailureRate * 100).toFixed(1) + '%';
    return '<div class="stat-breaker"><span class="mono">成功 ' + escapeHtml(statCount(record.windowSuccesses)) +
      ' / 失败 ' + escapeHtml(statCount(record.windowFailures)) + ' · ' + escapeHtml(rate) + '</span>' +
      (record.disableCooldown ? '<span>不受自动熔断限制 · 额度与人工仍生效</span>' : '') + '</div>';
  }

  function modelName(canonicalModel) {
    return escapeHtml(canonicalModel == null ? '' : String(canonicalModel));
  }

  function channelMetaById(data) {
    var meta = {};
    (data.channels || []).forEach(function(channel) {
      if (channel && channel.id) meta[channel.id] = { id: channel.id, name: channel.name || channel.id };
    });
    return meta;
  }

  function renderCards(data) {
    var stats = data.stats || {};
    var attempts = data.routingAttempts || {};
    var cards = [
      ['活跃请求', data.activeRequests, '当前进行中'],
      ['总请求', stats.requestsTotal, '自实例启动以来'],
      ['非流式 Messages', stats.responsesJson, 'JSON 响应'],
      ['流式 Messages', (stats.responsesSseNormalized || 0) + (stats.responsesSseRaw || 0), '标准化与原始 SSE'],
      ['渠道切换 / 重试', (attempts.channelSwitches || 0) + ' / ' + (attempts.sameChannelRetries || 0), '渠道 fallback / 同渠道重试'],
      ['含 Usage 响应', stats.usageResponses, '上游报告了用量数据'],
      ['HTTP 错误', (stats.errors4xx || 0) + ' / ' + (stats.errors5xx || 0), '客户端 4xx / 服务端 5xx'],
      ['更新时间', new Date().toLocaleTimeString(), '每秒刷新'],
    ];
    cardsEl.innerHTML = cards.map(function(card) {
      return '<div class="card"><div class="card-label">' + escapeHtml(card[0]) + '</div><div class="card-value">' + escapeHtml(card[1]) + '</div><div class="card-note">' + escapeHtml(card[2]) + '</div></div>';
    }).join('');
    document.getElementById('monitor-instance').textContent = data.instanceName || '代理实例';
    document.getElementById('monitor-route-count').textContent = (data.modelRoutes || []).length + ' 个模型';
    document.getElementById('monitor-channel-count').textContent = (data.channels || []).length + ' 个渠道';
  }

  function findModelChannelHealth(snapshot, channelId, canonicalModel) {
    return (snapshot.modelChannels || []).find(function(r) {
      return r.channelId === channelId && r.canonicalModel === canonicalModel;
    });
  }

  function chipClassForState(state) {
    if (state === 'closed') return 'route-chip-ok';
    if (state === 'half_open') return 'route-chip-warn';
    if (state === 'open') return 'route-chip-bad';
    return '';
  }

  function dotClassForState(state) {
    if (state === 'closed') return 'route-chip-dot-ok';
    if (state === 'half_open') return 'route-chip-dot-warn';
    if (state === 'open') return 'route-chip-dot-bad';
    return 'route-chip-dot-unknown';
  }

  function renderRoutes(data) {
    var focusedModel = routeBody.contains(document.activeElement) ? document.activeElement.getAttribute('data-model-toggle') : null;
    var routes = data.modelRoutes || [];
    var snapshot = data.healthSnapshot || { channels: [], modelChannels: [] };
    var meta = channelMetaById(data);
    var html = '';
    for (var ri = 0; ri < routes.length; ri += 1) {
      var route = routes[ri];
      var channelIds = route.channelIds || [];
      var canonicalModel = route.canonicalModel;
      var expanded = expandedModels[canonicalModel] === true;
      var chips = '';
      for (var ci = 0; ci < channelIds.length; ci += 1) {
        var channelId = channelIds[ci];
        var mc = findModelChannelHealth(snapshot, channelId, canonicalModel);
        var channelHealth = channelQuotaRecord(snapshot, channelId);
        var state = effectiveState(mc, channelHealth);
        var quotaSeconds = channelQuotaRemaining(snapshot, channelId);
        var chipClass = quotaSeconds > 0 ? 'route-chip-quota' : chipClassForState(state);
        var dotClass = quotaSeconds > 0 ? 'route-chip-dot-quota' : dotClassForState(state);
        var chipTitle = quotaSeconds > 0 ? ' title="额度冷却剩余 ' + escapeHtml(fmtQuotaRemaining(quotaSeconds)) + '"' : '';
        var details = meta[channelId] || { id: channelId, name: channelId };
        var displayName = (details.name && details.name !== channelId) ? details.name : channelId;
        chips += '<span class="route-chip ' + chipClass + '" data-route-model="' + escapeHtml(canonicalModel) + '"' + chipTitle + '>' +
          '<span class="route-chip-dot ' + dotClass + '"></span>' +
          '<span class="route-index">' + escapeHtml(ci + 1) + '</span>' +
          escapeHtml(displayName) +
          '</span>';
      }
      html += '<tr class="route-row" data-route-model="' + escapeHtml(canonicalModel) + '" style="cursor:pointer">' +
        '<td class="mono"><button type="button" class="route-toggle" data-model-toggle="' + escapeHtml(canonicalModel) + '" aria-expanded="' + expanded + '">' + escapeHtml(canonicalModel) + '</button></td>' +
        '<td><div class="route-chips">' + chips + '</div></td>' +
        '</tr>';
      if (expanded) {
        var detailCells = '';
        for (var di = 0; di < channelIds.length; di += 1) {
          var dChannelId = channelIds[di];
          var dMc = findModelChannelHealth(snapshot, dChannelId, canonicalModel);
          var dDetails = meta[dChannelId] || { id: dChannelId, name: dChannelId };
          var dState = dMc ? effectiveState(dMc, channelQuotaRecord(snapshot, dChannelId)) : 'idle';
          var dStats = requestStats(dMc);
          detailCells += '<div class="route-detail-grid">' +
            '<div><div class="rd-name">' + escapeHtml(dDetails.name || dChannelId) + '</div>' +
            '<div class="rd-id">' + escapeHtml(dChannelId) + '</div></div>' +
            '<div><div>' + stateBadge(dState === 'idle' ? null : dState) + '</div>' + quotaBadge(channelQuotaRecord(snapshot, dChannelId)) + manualBadge(channelQuotaRecord(snapshot, dChannelId)) + '</div>' +
            '<div>' + dStats.attempts + '</div>' +
            '<div>' + dStats.split + '</div>' +
            '<div>' + dStats.rate + '</div>' +
            '<div>' + breakerStat(dMc) + '</div>' +
            '<div>' + cooldown(dMc) + '</div>' +
            '<div class="reason" title="' + escapeHtml((dMc && dMc.lastFailureReason) || '-') + '">' + escapeHtml((dMc && dMc.lastFailureReason) || '-') + '</div>' +
            '</div>';
        }
        var header = '<div class="route-detail-header">' +
          '<div>渠道</div>' +
          '<div title="当前熔断状态">状态</div>' +
          '<div title="实例启动以来的上游尝试次数">尝试</div>' +
          '<div title="累计成功 / 失败次数">成功 / 失败</div>' +
          '<div title="实例启动以来的累计成功率">成功率</div>' +
          '<div title="滑动窗口失败次数与失败率">窗口</div>' +
          '<div title="自动冷却剩余秒数">冷却</div>' +
          '<div title="最近一次失败原因">原因</div></div>';
        html += '<tr class="route-detail-row"><td colspan="2">' +
          (channelIds.length > 0 ? header + detailCells : '<div class="empty-state">该模型未配置渠道。</div>') +
          '</td></tr>';
      }
    }
    routeBody.innerHTML = html || '<tr><td colspan="2"><div class="empty-state">尚未配置模型路由。</div></td></tr>';
    if (focusedModel !== null) {
      routeBody.querySelectorAll('[data-model-toggle]').forEach(function(button) {
        if (button.dataset.modelToggle === focusedModel) button.focus({ preventScroll: true });
      });
    }
  }

  function modelChildren(snapshot, channelId) {
    return (snapshot.modelChannels || []).filter(function(record) {
      return record.channelId === channelId;
    });
  }

  function renderModelChildren(records, channel) {
    if (records.length === 0) {
      return '<div class="empty-state">该渠道还没有模型维度的健康记录。</div>';
    }
    var header = '<div class="stat-model-child-header">' +
          '<div>模型</div>' +
      '<div title="当前熔断状态">状态</div>' +
      '<div title="实例启动以来的上游尝试次数">尝试</div>' +
      '<div title="累计成功 / 失败次数">成功 / 失败</div>' +
      '<div title="实例启动以来的累计成功率">成功率</div>' +
      '<div title="滑动窗口成功 / 失败次数与失败率">窗口</div>' +
      '<div title="自动冷却剩余秒数">冷却</div>' +
      '<div title="最近一次失败原因">原因</div></div>';
    return header + records.map(function(record) {
      var stats = requestStats(record);
      return '<div class="model-child">' +
        '<div class="model-name mono">' + modelName(record.canonicalModel) + '</div>' +
        '<div>' + stateBadge(effectiveState(record, channel)) + '</div>' +
        '<div>' + stats.attempts + '</div>' +
        '<div>' + stats.split + '</div>' +
        '<div>' + stats.rate + '</div>' +
        '<div>' + breakerStat(record) + '</div>' +
        '<div>' + escapeHtml(cooldown(record)) + '</div>' +
        '<div class="reason" title="' + escapeHtml(record.lastFailureReason || '-') + '">' + escapeHtml(record.lastFailureReason || '-') + '</div>' +
        '</div>';
    }).join('');
  }

  function renderChannels(data) {
    if (controllingChannel) return;
    var focusedControl = channelBody.contains(document.activeElement) && document.activeElement.dataset.breakerAction
      ? { channel: document.activeElement.dataset.breakerChannel, action: document.activeElement.dataset.breakerAction } : null;
    var focusedChannel = channelBody.contains(document.activeElement) ? document.activeElement.getAttribute('data-channel-id') : null;
    var snapshot = data.healthSnapshot || { channels: [], modelChannels: [] };
    var meta = channelMetaById(data);
    channelBody.innerHTML = (snapshot.channels || []).map(function(channel) {
      var channelId = channel.channelId;
      var details = meta[channelId] || { id: channelId, name: channelId };
      var children = modelChildren(snapshot, channelId);
      var expanded = expandedChannels[channelId] === true;
      var toggleText = expanded ? '收起' : '展开';
      var stats = requestStats(channel);
      return '<tr class="channel-row">' +
        '<td class="stat-col-channel"><div class="stat-channel-cell"><button type="button" class="toggle-button" data-channel-id="' + escapeHtml(channelId) + '" aria-expanded="' + expanded + '" aria-label="' + toggleText + ' ' + escapeHtml(channelId) + '">' + (expanded ? '−' : '+') + '</button>' +
        '<div class="channel-title"><span class="channel-id mono">' + escapeHtml(channelId) + '</span><span class="channel-name">' + escapeHtml(details.name) + '</span></div></div></td>' +
        '<td><div>' + stateBadge(effectiveState(channel, channel)) + '</div>' + quotaBadge(channel) + manualBadge(channel) + '</td>' +
        '<td>' + stats.attempts + '</td>' +
        '<td>' + stats.split + '</td>' +
        '<td>' + stats.rate + '</td>' +
        '<td>' + breakerStat(channel) + '</td>' +
        '<td>' + escapeHtml(cooldown(channel)) + '</td>' +
        '<td class="reason" title="' + escapeHtml(channel.lastFailureReason || '-') + '">' + escapeHtml(channel.lastFailureReason || '-') + '</td>' +
        '<td>' + escapeHtml(fmtTime(channel.lastSuccessAt)) +
        '<div class="breaker-actions"><button type="button" class="danger" data-breaker-action="open" data-breaker-channel="' + escapeHtml(channelId) + '" aria-label="立即熔断 ' + escapeHtml(channelId) + '">立即熔断</button>' +
        '<button type="button" data-breaker-action="close" data-breaker-channel="' + escapeHtml(channelId) + '" aria-label="立即恢复 ' + escapeHtml(channelId) + '">立即恢复</button></div></td>' +
        '</tr>' +
        '<tr class="model-row"' + (expanded ? '' : ' hidden') + '><td colspan="9"><div class="model-children">' + renderModelChildren(children, channel) + '</div></td></tr>';
    }).join('') || '<tr><td colspan="9"><div class="empty-state">还没有渠道健康记录。</div></td></tr>';
    if (focusedChannel !== null) {
      channelBody.querySelectorAll('[data-channel-id]').forEach(function(button) {
        if (button.dataset.channelId === focusedChannel) button.focus({ preventScroll: true });
      });
    }
    if (focusedControl) channelBody.querySelectorAll('[data-breaker-action]').forEach(function(button) {
      if (button.dataset.breakerChannel === focusedControl.channel && button.dataset.breakerAction === focusedControl.action) button.focus({ preventScroll: true });
    });
  }

  function renderTrend() {
    var peak = Math.max(0, ...samples.map(function(sample) {
      return sample.activeRequests || 0;
    }));
    var max = Math.max(1, peak);
    trendBars.innerHTML = samples.map(function(sample) {
      var active = sample.activeRequests || 0;
      var height = Math.max(2, Math.round((active / max) * 112));
      return '<span style="height:' + height + 'px" title="活跃请求 ' + active + '"></span>';
    }).join('');
    document.getElementById('trend-peak').textContent = '峰值 ' + peak;
    document.getElementById('trend-empty').hidden = peak > 0;
    document.getElementById('trend-start').textContent = samples.length + ' / 60 个采样点';
    trendBars.setAttribute('aria-label', samples.length + ' 个近期采样点；活跃请求峰值 ' + peak);
  }

  async function poll() {
    if (document.hidden) return;
    try {
      var response = await fetch('/admin/monitor/stats', { cache: 'no-store' });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var body = await response.json();
      body.activeRequests = (body.stats && body.stats.activeRequests) || 0;
      var policyEl = document.getElementById('breaker-policy');
      if (policyEl) {
        policyEl.hidden = !body.healthSnapshot;
        policyEl.textContent = '窗口 ' + (body.healthWindowMs / 1000) + 's：失败 ≥ ' + body.healthFailureThreshold +
          ' 且失败率 > ' + (body.healthFailureRateThreshold * 100) + '% → 熔断 ' + (body.healthCooldownMs / 60000) +
          ' 分钟；每渠道最多 ' + body.channelMaxAttempts + ' 次。人工恢复会清除额度冷却和失败窗口。';
      }
      document.getElementById('usage-nav').hidden = body.usageAvailable !== true;
      samples.push(body);
      if (samples.length > 60) samples.shift();
      renderCards(body);
      renderRoutes(body);
      renderChannels(body);
      renderTrend();
      statusEl.textContent = '最近更新 ' + new Date().toLocaleTimeString();
      statusEl.className = '';
    } catch (error) {
      statusEl.textContent = '监控更新失败：' + error.message;
      statusEl.className = 'error';
    }
  }

  function toggleChannel(channelId) {
    expandedChannels[channelId] = expandedChannels[channelId] !== true;
    if (samples.length > 0) {
      renderChannels(samples[samples.length - 1]);
    }
  }

  function schedule() {
    clearInterval(timer);
    if (!document.hidden) {
      poll();
      timer = setInterval(poll, 1000);
    } else {
      statusEl.textContent = '页面隐藏，已暂停刷新';
    }
  }

  document.addEventListener('visibilitychange', schedule);
  channelBody.addEventListener('click', async function(event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var control = target.closest('[data-breaker-action]');
    if (control) {
      if (controllingChannel) return;
      var channel = samples[samples.length - 1].healthSnapshot.channels.find(function(entry) { return entry.channelId === control.dataset.breakerChannel; });
      if (!channel) return;
      controllingChannel = channel.channelId;
      control.disabled = true;
      try {
        var response = await fetch('/admin/channels/breaker', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelId: channel.channelId, fingerprint: channel.fingerprint, action: control.dataset.breakerAction }) });
        var result = await response.json();
        if (!response.ok || !result.ok) throw new Error((result.error && result.error.message) || 'HTTP ' + response.status);
        controllingChannel = null;
        await poll();
        statusEl.textContent = channel.channelId + (control.dataset.breakerAction === 'open' ? ' 已立即熔断' : ' 已恢复，重新遵循自动规则');
      } catch (error) {
        statusEl.textContent = '操作失败：' + error.message;
        statusEl.className = 'error';
      } finally { controllingChannel = null; control.disabled = false; }
      return;
    }
    var button = target.closest('button[data-channel-id]');
    if (!button) return;
    var channelId = button.getAttribute('data-channel-id');
    if (!channelId) return;
    toggleChannel(channelId);
  });
  routeBody.addEventListener('click', function(event) {
    var target = event.target;
    if (!target || !target.closest) return;
    var row = target.closest('tr.route-row');
    if (!row) return;
    var model = row.getAttribute('data-route-model');
    if (!model) return;
    expandedModels[model] = expandedModels[model] !== true;
    if (samples.length > 0) {
      renderRoutes(samples[samples.length - 1]);
    }
  });
  schedule();
})();
