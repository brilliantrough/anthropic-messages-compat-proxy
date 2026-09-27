(function() {
  var statusEl = document.getElementById('status');
  var dirtyBadge = document.getElementById('dirty-badge');
  var restartNotice = document.getElementById('restart-notice');
  var validationResult = document.getElementById('validation-result');
  var actionResult = document.getElementById('action-result');
  var instanceSummary = document.getElementById('instance-summary');
  var topbarRuntimeVersion = document.getElementById('topbar-runtime-version');
  var topbarActiveRequests = document.getElementById('topbar-active-requests');
  var defaultModelInput = document.getElementById('default-model-input');

  var serverConfig = null;
  var serverMeta = null;
  var draftEnv = [];
  var draftDefaultModel = '';
  var draftChannels = [];
  var draftModels = [];
  var draftAliases = {};
  var dirty = false;
  var selectedModelIdx = 0;

  var views = {
    channels: ['渠道', '接入上游 Anthropic 渠道，构建可容错的网关。'],
    models: ['模型路由', '为每个模型配置渠道优先级与回退顺序。'],
    aliases: ['别名', '用简短名称指向规范模型。'],
    environment: ['环境设置', '调整网关运行参数。'],
    runtime: ['运行快照', '当前实例的实际生效配置。'],
  };

  function showView() {
    var view = window.location.hash.slice(1);
    if (!Object.prototype.hasOwnProperty.call(views, view)) view = 'channels';
    document.querySelectorAll('.config-view').forEach(function(section) {
      section.hidden = section.id !== view;
    });
    document.querySelectorAll('[data-view]').forEach(function(link) {
      var active = link.dataset.view === view;
      link.classList.toggle('active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    document.getElementById('page-title').textContent = views[view][0];
    document.getElementById('page-breadcrumb').textContent = views[view][0];
    document.getElementById('page-description').textContent = views[view][1];
    document.title = views[view][0] + ' · Relay';
    window.scrollTo(0, 0);
  }

  function renderDraftSummary() {
    document.getElementById('summary-channels').textContent = draftChannels.length;
    document.getElementById('summary-models').textContent = draftModels.length;
    document.getElementById('summary-aliases').textContent = Object.keys(draftAliases).length;
    document.getElementById('summary-default').textContent = draftDefaultModel || '未设置';
    document.getElementById('nav-channel-count').textContent = draftChannels.length;
    document.getElementById('nav-model-count').textContent = draftModels.length;
    document.getElementById('channel-count').textContent = draftChannels.length;
  }

  function filterChannels() {
    var query = document.getElementById('channel-search').value.trim().toLowerCase();
    var shown = 0;
    document.querySelectorAll('#channels-table .channel-row').forEach(function(row, index) {
      var channel = draftChannels[index];
      row.hidden = [channel.id, channel.name, channel.baseUrl].join(' ').toLowerCase().indexOf(query) < 0;
      if (!row.hidden) shown += 1;
    });
    document.getElementById('channel-search-empty').hidden = shown > 0 || draftChannels.length === 0;
    document.getElementById('channel-count').textContent = query ? shown + ' / ' + draftChannels.length : draftChannels.length;
  }

  function filterEnvironment() {
    var query = document.getElementById('env-search').value.trim().toLowerCase();
    var shown = 0;
    document.querySelectorAll('#primary-table tbody tr').forEach(function(row) {
      row.hidden = row.firstElementChild.textContent.toLowerCase().indexOf(query) < 0;
      if (!row.hidden) shown += 1;
    });
    document.getElementById('env-search-empty').hidden = shown > 0;
  }

  var RUNTIME_KEYS = [
    'PORT', 'HOST', 'INSTANCE_NAME', 'ANTHROPIC_VERSION', 'ANTHROPIC_BETA',
    'PROXY_STREAM_MODE', 'PROXY_CLAUDE_BILLING_HEADER_MODE',
    'PROXY_UPSTREAM_TIMEOUT_MS', 'PROXY_NON_STREAM_TIMEOUT_MS', 'PROXY_FIRST_BYTE_TIMEOUT_MS',
    'PROXY_FIRST_TEXT_TIMEOUT_MS', 'PROXY_STREAM_IDLE_TIMEOUT_MS', 'PROXY_TOTAL_REQUEST_TIMEOUT_MS',
    'PROXY_MAX_CONCURRENT_REQUESTS', 'PROXY_MAX_FALLBACK_TOTAL_MS',
    'PROXY_HEALTH_WINDOW_MS', 'PROXY_HEALTH_FAILURE_THRESHOLD', 'PROXY_HEALTH_FAILURE_RATE_THRESHOLD',
    'PROXY_HEALTH_COOLDOWN_MS', 'PROXY_CHANNEL_MAX_ATTEMPTS', 'PROXY_CHANNEL_RETRY_DELAY_MS',
    'PROXY_QUOTA_COOLDOWN_MS'
  ];

  function esc(value) {
    var div = document.createElement('div');
    div.textContent = value;
    return div.innerHTML;
  }

  function appendHelperText(container, text) {
    if (!text) return;
    var helperEl = document.createElement('div');
    helperEl.className = 'field-helper';
    helperEl.textContent = text;
    container.appendChild(helperEl);
  }

  function createFieldStack(control, helperText) {
    var stack = document.createElement('div');
    stack.className = 'field-stack';
    stack.appendChild(control);
    appendHelperText(stack, helperText);
    return stack;
  }

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? 'notice notice-error' : 'notice notice-info';
  }

  function setDirty(nextDirty) {
    dirty = nextDirty;
    dirtyBadge.style.display = nextDirty ? 'inline-block' : 'none';
    dirtyBadge.className = nextDirty ? 'badge badge-dirty' : 'badge badge-ok';
    renderDraftSummary();
    filterChannels();
  }

  function getEnvValue(key) {
    var envArr = (serverConfig && serverConfig.env) || [];
    var entry = envArr.filter(function(item) { return item.key === key; })[0];
    return entry ? entry.value : '';
  }

  function showRestartNotice(fields) {
    if (fields && fields.length > 0) {
      var hasPortHost = fields.some(function(field) { return field === 'PORT' || field === 'HOST'; });
      restartNotice.style.display = 'block';
      restartNotice.className = hasPortHost ? 'notice notice-warning notice-restart' : 'notice notice-error';
      restartNotice.textContent = hasPortHost
        ? '需要重启：' + fields.join(', ') + ' 已变更，需重启代理进程后生效。'
        : '已修改字段：' + fields.join(', ');
    } else {
      restartNotice.style.display = 'none';
    }
  }

  function appendOverviewField(container, label, value) {
    var group = document.createElement('div');
    group.className = 'field-group';
    var labelEl = document.createElement('label');
    labelEl.textContent = label;
    var input = document.createElement('input');
    input.readOnly = true;
    input.value = value == null ? '' : String(value);
    group.appendChild(labelEl);
    group.appendChild(input);
    container.appendChild(group);
  }

  function renderTopbarSummary() {
    if (!serverConfig || !serverMeta) return;
    var instanceName = getEnvValue('INSTANCE_NAME') || '未知实例';
    var host = getEnvValue('HOST');
    var port = getEnvValue('PORT');
    var address = [host, port ? ':' + port : ''].filter(Boolean).join('');
    instanceSummary.textContent = [instanceName, address].filter(Boolean).join('  /  ');
    var activeRequests = typeof serverMeta.activeRequests === 'number' ? serverMeta.activeRequests : '-';
    topbarRuntimeVersion.textContent = '运行版本 ' + (serverMeta.runtimeVersion || '-');
    topbarActiveRequests.textContent = '活跃 ' + activeRequests;
  }

  function renderOverview() {
    document.getElementById('ov-version').value = serverMeta.runtimeVersion || '-';
    document.getElementById('ov-restart').value = (serverMeta.restartRequiredFields || []).join(', ') || '（无）';
    var info = document.getElementById('ov-instance-info');
    info.textContent = '';
    var inst = (serverConfig.env || []).filter(function(entry) { return entry.key === 'INSTANCE_NAME'; })[0];
    var port = (serverConfig.env || []).filter(function(entry) { return entry.key === 'PORT'; })[0];
    if (inst) appendOverviewField(info, '实例', inst.value);
    if (port) appendOverviewField(info, '端口', port.value);
  }

  function renderEnvTable() {
    var tbody = document.querySelector('#primary-table tbody');
    tbody.innerHTML = '';
    var envArr = draftEnv;
    var policyHelp = {
      PROXY_HEALTH_WINDOW_MS: '滑动窗口毫秒；默认 180000（3 分钟）。',
      PROXY_HEALTH_FAILURE_THRESHOLD: '窗口内失败至少达到此次数，且失败率超限才熔断。按真实上游尝试计数。',
      PROXY_HEALTH_FAILURE_RATE_THRESHOLD: '失败 /（成功 + 失败）严格大于此值；默认 0.5。',
      PROXY_HEALTH_COOLDOWN_MS: '普通与人工熔断时长，毫秒；默认 600000（10 分钟）。',
      PROXY_CHANNEL_MAX_ATTEMPTS: '每个请求、每个渠道的总尝试上限，包含首次；默认 3。',
      PROXY_CHANNEL_RETRY_DELAY_MS: '同渠道两次尝试之间的等待毫秒；默认 500，额度耗尽直接换渠道。',
      PROXY_QUOTA_COOLDOWN_MS: '额度耗尽冷却毫秒；不随熔断器豁免，可在概览页立即恢复。',
    };
    for (var i = 0; i < envArr.length; i += 1) {
      var envEntry = envArr[i];
      var draftEntry = draftEnv.filter(function(entry) { return entry.key === envEntry.key; })[0];
      if (!draftEntry) continue;

      var row = document.createElement('tr');
      var keyCell = document.createElement('td');
      keyCell.textContent = envEntry.key;
      row.appendChild(keyCell);

      var valueCell = document.createElement('td');
      var control;
      if (envEntry.secret) {
        control = document.createElement('input');
        control.type = 'password';
        control.placeholder = '***（已隐藏）';
        control.value = '';
        control.dataset.key = envEntry.key;
        control.addEventListener('input', function() {
          var key = this.dataset.key;
          for (var j = 0; j < draftEnv.length; j += 1) {
            if (draftEnv[j].key === key) {
              draftEnv[j].secretAction = this.value ? 'replace' : 'keep';
              draftEnv[j].value = this.value || undefined;
              break;
            }
          }
          checkDirty();
        });
      } else if (envEntry.key === 'PROXY_CLAUDE_BILLING_HEADER_MODE') {
        control = document.createElement('select');
        ['strip_line', 'strip_cch'].forEach(function(mode) {
          var option = document.createElement('option');
          option.value = mode;
          option.textContent = mode;
          if ((draftEntry.value || 'strip_line') === mode) option.selected = true;
          control.appendChild(option);
        });
        control.dataset.key = envEntry.key;
        control.addEventListener('change', function() {
          var key = this.dataset.key;
          for (var j = 0; j < draftEnv.length; j += 1) {
            if (draftEnv[j].key === key) {
              draftEnv[j].value = this.value;
              break;
            }
          }
          checkDirty();
        });
      } else {
        control = document.createElement('input');
        control.type = 'text';
        control.value = draftEntry.value || '';
        control.dataset.key = envEntry.key;
        control.addEventListener('input', function() {
          var key = this.dataset.key;
          for (var j = 0; j < draftEnv.length; j += 1) {
            if (draftEnv[j].key === key) {
              draftEnv[j].value = this.value;
              break;
            }
          }
          checkDirty();
        });
      }
      control.setAttribute('aria-label', envEntry.key);
      var legacy = /^(PROXY_CHANNEL_COOLDOWN_MS|PROXY_MODEL_CHANNEL_COOLDOWN_MS|PROXY_CHANNEL_FAILURE_THRESHOLD|PROXY_MODEL_CHANNEL_FAILURE_THRESHOLD|PROXY_HALF_OPEN_MAX_PROBES|PROXY_MAX_FALLBACK_ATTEMPTS)$/.test(envEntry.key) || envEntry.key.indexOf('PROXY_ENDPOINT_') === 0;
      valueCell.appendChild(createFieldStack(control, legacy ? '旧参数已停用；请使用 PROXY_HEALTH_* 与 PROXY_CHANNEL_MAX_ATTEMPTS。' : policyHelp[envEntry.key] || ''));
      row.appendChild(valueCell);

      var secretCell = document.createElement('td');
      secretCell.textContent = envEntry.secret ? '是' : '否';
      row.appendChild(secretCell);
      tbody.appendChild(row);
    }
    filterEnvironment();
  }

  function renderDefaultModel() {
    defaultModelInput.value = draftDefaultModel;
  }

  function renderChannels() {
    var tbody = document.querySelector('#channels-table tbody');
    tbody.innerHTML = '';
    if (draftChannels.length === 0) {
      var emptyRow = document.createElement('tr');
      var emptyCell = document.createElement('td');
      emptyCell.colSpan = 6;
      emptyCell.className = 'loading';
      emptyCell.textContent = '当前草稿中没有渠道。';
      emptyRow.appendChild(emptyCell);
      tbody.appendChild(emptyRow);
      return;
    }

    for (var i = 0; i < draftChannels.length; i += 1) {
      (function(index) {
        var channel = draftChannels[index];
        var row = document.createElement('tr');
        row.className = 'channel-row';

        var idCell = document.createElement('td');
        var idInput = document.createElement('input');
        idInput.type = 'text';
        idInput.value = channel.id;
        idInput.dataset.idx = String(index);
        idInput.addEventListener('input', function() {
          draftChannels[Number(this.dataset.idx)].id = this.value;
          renderModelRoutes();
          checkDirty();
        });
        idCell.appendChild(createFieldStack(idInput, '稳定的渠道标识，用于路由引用。'));
        row.appendChild(idCell);

        var nameCell = document.createElement('td');
        var nameInput = document.createElement('input');
        nameInput.type = 'text';
        nameInput.value = channel.name || '';
        nameInput.dataset.idx = String(index);
        nameInput.addEventListener('input', function() {
          draftChannels[Number(this.dataset.idx)].name = this.value;
          renderModelRoutes();
          checkDirty();
        });
        nameCell.appendChild(createFieldStack(nameInput, '可选显示名称。'));
        row.appendChild(nameCell);

        var baseUrlCell = document.createElement('td');
        var baseUrlInput = document.createElement('input');
        baseUrlInput.type = 'text';
        baseUrlInput.value = channel.baseUrl;
        baseUrlInput.dataset.idx = String(index);
        baseUrlInput.addEventListener('input', function() {
          draftChannels[Number(this.dataset.idx)].baseUrl = this.value;
          checkDirty();
        });
        baseUrlCell.appendChild(createFieldStack(baseUrlInput, '渠道基础地址。'));
        row.appendChild(baseUrlCell);

        var keyCell = document.createElement('td');
        var keyWrap = document.createElement('div');
        keyWrap.className = 'channel-key-wrap';
        var toggleRow = document.createElement('div');
        toggleRow.className = 'toggle-row';
        [['keep', '保留'], ['replace', '替换']].forEach(function(pair) {
          var action = pair[0];
          var button = document.createElement('button');
          button.type = 'button';
          button.className = channel.apiKeyAction === action ? 'primary' : '';
          button.textContent = pair[1];
          button.dataset.idx = String(index);
          button.dataset.action = action;
          button.addEventListener('click', function() {
            var idx = Number(this.dataset.idx);
            draftChannels[idx].apiKeyAction = this.dataset.action;
            if (this.dataset.action === 'keep') {
              draftChannels[idx].apiKeyValue = undefined;
            }
            renderChannels();
            checkDirty();
          });
          toggleRow.appendChild(button);
        });
        keyWrap.appendChild(toggleRow);

        if (channel.apiKeyAction === 'replace') {
          var keyInput = document.createElement('input');
          keyInput.type = 'password';
          keyInput.placeholder = '新的 API Key';
          keyInput.value = channel.apiKeyValue || '';
          keyInput.dataset.idx = String(index);
          keyInput.addEventListener('input', function() {
            draftChannels[Number(this.dataset.idx)].apiKeyValue = this.value;
            checkDirty();
          });
          keyWrap.appendChild(createFieldStack(keyInput, '输入替换用的 API Key。'));
        } else {
          var masked = document.createElement('div');
          masked.className = 'masked-secret';
          masked.textContent = '•••••••• · 已保留';
          keyWrap.appendChild(masked);
        }
        keyCell.appendChild(keyWrap);
        row.appendChild(keyCell);

        var breakerCell = document.createElement('td');
        var breakerLabel = document.createElement('label');
        breakerLabel.className = 'breaker-toggle';
        var breakerInput = document.createElement('input');
        breakerInput.type = 'checkbox';
        breakerInput.checked = channel.disableCooldown === true;
        breakerInput.dataset.idx = String(index);
        breakerInput.addEventListener('change', function() {
          draftChannels[Number(this.dataset.idx)].disableCooldown = this.checked;
          checkDirty();
        });
        breakerLabel.appendChild(breakerInput);
        breakerLabel.appendChild(document.createTextNode(' 不受熔断器限制'));
        breakerCell.appendChild(breakerLabel);
        row.appendChild(breakerCell);

        var actionCell = document.createElement('td');
        var actions = document.createElement('div');
        actions.className = 'row-actions';
        var deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'danger icon-button';
        deleteButton.textContent = '删除';
        deleteButton.dataset.idx = String(index);
        deleteButton.addEventListener('click', function() {
          draftChannels.splice(Number(this.dataset.idx), 1);
          renderChannels();
          renderModelRoutes();
          checkDirty();
        });
        actions.appendChild(deleteButton);
        actionCell.appendChild(actions);
        row.appendChild(actionCell);

        ['渠道 ID', '显示名称', '基础地址', 'API Key', '熔断器', '操作'].forEach(function(label, cellIndex) {
          var cell = row.children[cellIndex];
          cell.dataset.label = label;
          cell.querySelectorAll('input').forEach(function(input) {
            input.setAttribute('aria-label', label + ' · ' + channel.id);
          });
        });
        tbody.appendChild(row);
      })(i);
    }
    filterChannels();
  }

  function getRouteChannelLabel(channelId) {
    for (var i = 0; i < draftChannels.length; i += 1) {
      if (draftChannels[i].id === channelId) {
        return {
          id: channelId,
          name: draftChannels[i].name || '',
          missing: false,
        };
      }
    }
    return { id: channelId, name: '', missing: true };
  }

  function appendChannelIdentity(container, channelInfo) {
    var name = document.createElement('span');
    name.className = 'route-channel-name cname';
    name.textContent = channelInfo.name || channelInfo.id || '（空 ID）';
    container.appendChild(name);

    if (channelInfo.name && channelInfo.id) {
      var id = document.createElement('span');
      id.className = 'route-channel-id cid';
      id.textContent = channelInfo.id;
      container.appendChild(id);
    }

    if (channelInfo.missing) {
      var missing = document.createElement('span');
      missing.className = 'route-channel-id cid';
      missing.textContent = '渠道缺失';
      container.appendChild(missing);
    }
  }

  function updateRouteChannels(routeIndex, channelIds) {
    draftModels[routeIndex].channelIds = channelIds.slice();
    renderModelRoutes();
    checkDirty();
  }

  function enableRouteSorting(container, list, channelIds, onChange) {
    var rows = Array.from(list.querySelectorAll('.route-selected-item'));
    var drag = null;
    var frame = null;
    list.setAttribute('role', 'list');

    function move(from, to) {
      if (from === to) return;
      var ids = channelIds.slice();
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      var scrollTop = list.scrollTop;
      onChange(ids);
      container.querySelector('.route-selected-list').scrollTop = scrollTop;
    }

    function clearDrag() {
      if (!drag) return;
      var pointerId = drag.pointerId;
      drag = null;
      cancelAnimationFrame(frame);
      rows.forEach(function(row) { row.classList.remove('sorting', 'drop-before', 'drop-after'); });
      if (list.hasPointerCapture(pointerId)) list.releasePointerCapture(pointerId);
    }

    function preview() {
      if (!drag) return;
      if (!list.isConnected || !list.getClientRects().length) { clearDrag(); return; }
      var bounds = list.getBoundingClientRect();
      var inside = drag.x >= bounds.left && drag.x <= bounds.right && drag.y >= bounds.top && drag.y <= bounds.bottom;
      rows.forEach(function(row) { row.classList.remove('drop-before', 'drop-after'); });
      drag.to = drag.from;
      if (inside && drag.moved) {
        if (drag.y < Math.max(bounds.top, 0) + 28) list.scrollTop -= 8;
        if (drag.y > Math.min(bounds.bottom, window.innerHeight) - 28) list.scrollTop += 8;
        var boundary = rows.findIndex(function(row) {
          var rect = row.getBoundingClientRect();
          return drag.y < rect.top + rect.height / 2;
        });
        if (boundary < 0) boundary = rows.length;
        drag.to = boundary > drag.from ? boundary - 1 : boundary;
        if (drag.to !== drag.from) {
          (rows[boundary] || rows[rows.length - 1]).classList.add(boundary === rows.length ? 'drop-after' : 'drop-before');
        }
      }
      frame = requestAnimationFrame(preview);
    }

    rows.forEach(function(row, index) {
      row.setAttribute('role', 'listitem');
      var handle = document.createElement('button');
      handle.type = 'button';
      handle.className = 'route-drag-handle';
      handle.textContent = '⠿';
      handle.title = '拖动排序 · 方向键移动 · Home / End 到两端';
      handle.setAttribute('aria-label', '调整 ' + channelIds[index] + ' 的优先级，当前为第 ' + (index + 1));
      handle.addEventListener('pointerdown', function(event) {
        if (event.button !== 0 || !event.isPrimary) return;
        drag = { from: index, to: index, pointerId: event.pointerId, x: event.clientX, y: event.clientY, startY: event.clientY, moved: false };
        list.setPointerCapture(event.pointerId);
        row.classList.add('sorting');
        preview();
      });
      handle.addEventListener('keydown', function(event) {
        var target = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: rows.length - 1 }[event.key];
        if (target === undefined) return;
        event.preventDefault();
        target = Math.max(0, Math.min(rows.length - 1, target));
        move(index, target);
        container.querySelectorAll('.route-drag-handle')[target].focus();
      });
      row.prepend(handle);
    });
    list.addEventListener('pointermove', function(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
      drag.moved = drag.moved || Math.abs(drag.y - drag.startY) > 4;
    });
    list.addEventListener('pointerup', function(event) {
      if (!drag || event.pointerId !== drag.pointerId) return;
      drag.x = event.clientX;
      drag.y = event.clientY;
      cancelAnimationFrame(frame);
      preview();
      if (!drag) return;
      var from = drag.from;
      var to = drag.to;
      clearDrag();
      move(from, to);
    });
    list.addEventListener('pointercancel', clearDrag);
    list.addEventListener('lostpointercapture', clearDrag);
    list.addEventListener('keydown', function(event) {
      if (event.key === 'Escape') clearDrag();
    });
  }

  function renderModelRoutes() {
    var container = document.getElementById('model-routes-list');
    container.innerHTML = '';
    if (draftModels.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'loading';
      empty.textContent = '暂无模型路由。点击「+ 添加路由」新建。';
      container.appendChild(empty);
      return;
    }

    if (selectedModelIdx >= draftModels.length) {
      selectedModelIdx = draftModels.length - 1;
    }

    var split = document.createElement('div');
    split.className = 'route-split';

    var sidebar = document.createElement('div');
    sidebar.className = 'route-sidebar';

    var sidebarList = document.createElement('div');
    sidebarList.className = 'route-sidebar-list';

    for (var i = 0; i < draftModels.length; i += 1) {
      (function(index) {
        var item = document.createElement('button');
        item.type = 'button';
        item.className = 'route-sidebar-item' + (index === selectedModelIdx ? ' active' : '');
        item.setAttribute('aria-pressed', String(index === selectedModelIdx));
        item.textContent = draftModels[index].canonicalModel || '（未命名）';
        var count = document.createElement('span');
        count.className = 'route-sidebar-count';
        count.textContent = String(draftModels[index].channelIds.length);
        item.appendChild(count);
        item.addEventListener('click', function() {
          selectedModelIdx = index;
          renderModelRoutes();
        });
        sidebarList.appendChild(item);
      })(i);
    }
    sidebar.appendChild(sidebarList);

    var sidebarActions = document.createElement('div');
    sidebarActions.className = 'route-sidebar-actions';
    var addButton = document.createElement('button');
    addButton.type = 'button';
    addButton.textContent = '+ 添加路由';
    addButton.addEventListener('click', function() {
      draftModels.push({ canonicalModel: 'new-model-' + Date.now(), channelIds: [] });
      selectedModelIdx = draftModels.length - 1;
      renderModelRoutes();
      checkDirty();
    });
    sidebarActions.appendChild(addButton);
    sidebar.appendChild(sidebarActions);
    split.appendChild(sidebar);

    var route = draftModels[selectedModelIdx];
    var detail = document.createElement('div');
    detail.className = 'route-detail';

    var header = document.createElement('div');
    header.className = 'route-detail-header';
    var modelInput = document.createElement('input');
    modelInput.type = 'text';
    modelInput.value = route.canonicalModel;
    modelInput.placeholder = '规范模型名';
    modelInput.setAttribute('aria-label', '规范模型名');
    modelInput.addEventListener('input', function() {
      draftModels[selectedModelIdx].canonicalModel = this.value;
      document.querySelector('.route-sidebar-item.active').firstChild.textContent = this.value || '（未命名）';
      checkDirty();
    });
    header.appendChild(modelInput);

    var deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'danger';
    deleteBtn.textContent = '删除';
    deleteBtn.addEventListener('click', function() {
      draftModels.splice(selectedModelIdx, 1);
      if (selectedModelIdx >= draftModels.length) {
        selectedModelIdx = Math.max(0, draftModels.length - 1);
      }
      renderModelRoutes();
      checkDirty();
    });
    header.appendChild(deleteBtn);
    detail.appendChild(header);

    var body = document.createElement('div');
    body.className = 'route-detail-body';

    var selectedCol = document.createElement('div');
    selectedCol.className = 'route-detail-selected';
    var selectedTitle = document.createElement('h4');
    selectedTitle.textContent = '回退顺序 · 拖动 ⠿ 调整';
    selectedCol.appendChild(selectedTitle);

    var selectedList = document.createElement('div');
    selectedList.className = 'route-selected-list';

    if (route.channelIds.length === 0) {
      var emptySelected = document.createElement('div');
      emptySelected.className = 'route-empty-selected';
      emptySelected.textContent = '路由中还没有渠道，请从右侧添加。';
      selectedList.appendChild(emptySelected);
    } else {
      route.channelIds.forEach(function(channelId, position) {
        var channelInfo = getRouteChannelLabel(channelId);
        var item = document.createElement('div');
        item.className = 'route-selected-item';

        var num = document.createElement('span');
        num.className = 'route-selected-number';
        num.textContent = String(position + 1);
        item.appendChild(num);

        var nameDiv = document.createElement('div');
        nameDiv.className = 'route-selected-name';
        var cname = document.createElement('span');
        cname.className = 'cname';
        cname.textContent = channelInfo.name || channelInfo.id || '（空）';
        nameDiv.appendChild(cname);
        if (channelInfo.name && channelInfo.id && channelInfo.name !== channelInfo.id) {
          var cid = document.createElement('span');
          cid.className = 'cid';
          cid.textContent = channelInfo.id;
          nameDiv.appendChild(cid);
        }
        if (channelInfo.missing) {
          var missing = document.createElement('span');
          missing.className = 'cid';
          missing.style.color = 'var(--status-error)';
          missing.textContent = 'missing';
          nameDiv.appendChild(missing);
        }
        item.appendChild(nameDiv);

        var actions = document.createElement('div');
        actions.className = 'route-selected-actions';

        var upBtn = document.createElement('button');
        upBtn.type = 'button';
        upBtn.textContent = '\u2191';
        upBtn.setAttribute('aria-label', '上移渠道');
        upBtn.disabled = position === 0;
        upBtn.dataset.position = String(position);
        upBtn.addEventListener('click', function() {
          var p = Number(this.dataset.position);
          var ids = draftModels[selectedModelIdx].channelIds.slice();
          var moved = ids.splice(p, 1)[0];
          ids.splice(p - 1, 0, moved);
          draftModels[selectedModelIdx].channelIds = ids;
          renderModelRoutes();
          checkDirty();
        });
        actions.appendChild(upBtn);

        var downBtn = document.createElement('button');
        downBtn.type = 'button';
        downBtn.textContent = '\u2193';
        downBtn.setAttribute('aria-label', '下移渠道');
        downBtn.disabled = position === route.channelIds.length - 1;
        downBtn.dataset.position = String(position);
        downBtn.addEventListener('click', function() {
          var p = Number(this.dataset.position);
          var ids = draftModels[selectedModelIdx].channelIds.slice();
          var moved = ids.splice(p, 1)[0];
          ids.splice(p + 1, 0, moved);
          draftModels[selectedModelIdx].channelIds = ids;
          renderModelRoutes();
          checkDirty();
        });
        actions.appendChild(downBtn);

        var rmBtn = document.createElement('button');
        rmBtn.type = 'button';
        rmBtn.textContent = '\u00d7';
        rmBtn.setAttribute('aria-label', '从路由中移除渠道');
        rmBtn.dataset.position = String(position);
        rmBtn.addEventListener('click', function() {
          var p = Number(this.dataset.position);
          var ids = draftModels[selectedModelIdx].channelIds.slice();
          ids.splice(p, 1);
          draftModels[selectedModelIdx].channelIds = ids;
          renderModelRoutes();
          checkDirty();
        });
        actions.appendChild(rmBtn);

        item.appendChild(actions);
        selectedList.appendChild(item);
      });
    }
    var routeIndex = selectedModelIdx;
    enableRouteSorting(container, selectedList, route.channelIds, function(ids) { updateRouteChannels(routeIndex, ids); });
    selectedCol.appendChild(selectedList);
    body.appendChild(selectedCol);

    var availableCol = document.createElement('div');
    availableCol.className = 'route-detail-available';
    var availableTitle = document.createElement('h4');
    availableTitle.textContent = '可用渠道';
    availableCol.appendChild(availableTitle);

    var availableList = document.createElement('div');
    availableList.className = 'route-available-list';
    var availableCount = 0;

    draftChannels.forEach(function(channel) {
      if (!channel.id || route.channelIds.indexOf(channel.id) >= 0) return;
      availableCount += 1;
      var item = document.createElement('div');
      item.className = 'route-available-item';

      var nameDiv = document.createElement('div');
      nameDiv.className = 'route-available-name';
      var cname = document.createElement('span');
      cname.className = 'cname';
      cname.textContent = channel.name || channel.id;
      nameDiv.appendChild(cname);
      if (channel.name && channel.id && channel.name !== channel.id) {
        var cid = document.createElement('span');
        cid.className = 'cid';
        cid.textContent = channel.id;
        nameDiv.appendChild(cid);
      }
      item.appendChild(nameDiv);

      var addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'route-available-add';
      addBtn.textContent = '+ 添加';
      addBtn.dataset.channelId = channel.id;
      addBtn.addEventListener('click', function() {
        draftModels[selectedModelIdx].channelIds.push(this.dataset.channelId);
        renderModelRoutes();
        checkDirty();
      });
      item.appendChild(addBtn);
      availableList.appendChild(item);
    });

    if (availableCount === 0) {
      var emptyAvailable = document.createElement('div');
      emptyAvailable.className = 'route-empty-available';
      emptyAvailable.textContent = '所有渠道都已在该路由中。';
      availableList.appendChild(emptyAvailable);
    }
    availableCol.appendChild(availableList);
    body.appendChild(availableCol);

    detail.appendChild(body);
    split.appendChild(detail);
    container.appendChild(split);
  }

  function renderAliases() {
    var container = document.getElementById('aliases-list');
    container.innerHTML = '';
    var keys = Object.keys(draftAliases);
    if (keys.length === 0) {
      var empty = document.createElement('div');
      empty.className = 'loading';
      empty.textContent = '当前草稿中没有别名。';
      container.appendChild(empty);
      return;
    }

    for (var i = 0; i < keys.length; i += 1) {
      (function(alias) {
        var row = document.createElement('div');
        row.className = 'mapping-row';

        var aliasCol = document.createElement('div');
        aliasCol.className = 'mapping-col';
        var aliasInput = document.createElement('input');
        aliasInput.type = 'text';
        aliasInput.value = alias;
        aliasInput.setAttribute('aria-label', '客户端可见别名');
        aliasInput.dataset.alias = alias;
        aliasInput.addEventListener('input', function() {
          var original = this.dataset.alias;
          var nextAlias = this.value;
          var target = draftAliases[original];
          delete draftAliases[original];
          draftAliases[nextAlias] = target;
          this.dataset.alias = nextAlias;
          targetInput.dataset.alias = nextAlias;
          deleteButton.dataset.alias = nextAlias;
          checkDirty();
        });
        aliasCol.appendChild(aliasInput);
        appendHelperText(aliasCol, '客户端请求时使用的别名。');
        row.appendChild(aliasCol);

        var arrow = document.createElement('div');
        arrow.className = 'mapping-arrow';
        arrow.textContent = '\u2192';
        row.appendChild(arrow);

        var targetCol = document.createElement('div');
        targetCol.className = 'mapping-col';
        var targetInput = document.createElement('input');
        targetInput.type = 'text';
        targetInput.value = draftAliases[alias];
        targetInput.setAttribute('aria-label', '规范模型目标');
        targetInput.dataset.alias = alias;
        targetInput.addEventListener('input', function() {
          draftAliases[this.dataset.alias] = this.value;
          checkDirty();
        });
        targetCol.appendChild(targetInput);
        appendHelperText(targetCol, '别名解析到的规范模型。');
        row.appendChild(targetCol);

        var actions = document.createElement('div');
        actions.className = 'row-actions';
        var deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'danger icon-button';
        deleteButton.textContent = '\u00d7';
        deleteButton.setAttribute('aria-label', '删除别名');
        deleteButton.dataset.alias = alias;
        deleteButton.addEventListener('click', function() {
          delete draftAliases[this.dataset.alias];
          renderAliases();
          checkDirty();
        });
        actions.appendChild(deleteButton);
        row.appendChild(actions);

        container.appendChild(row);
      })(keys[i]);
    }
  }

  function renderRuntime() {
    var tbody = document.querySelector('#runtime-table tbody');
    tbody.innerHTML = '';
    var envArr = serverConfig.env || [];
    for (var i = 0; i < envArr.length; i += 1) {
      var envEntry = envArr[i];
      if (RUNTIME_KEYS.indexOf(envEntry.key) < 0) continue;
      var row = document.createElement('tr');
      var keyCell = document.createElement('td');
      keyCell.textContent = envEntry.key;
      row.appendChild(keyCell);
      var valueCell = document.createElement('td');
      valueCell.textContent = envEntry.secret ? '***' : envEntry.value;
      row.appendChild(valueCell);
      tbody.appendChild(row);
    }
  }

  function render() {
    renderTopbarSummary();
    renderOverview();
    renderEnvTable();
    renderDefaultModel();
    renderChannels();
    renderModelRoutes();
    renderAliases();
    renderRuntime();
    showRestartNotice(serverMeta.restartRequiredFields);
    setDirty(false);
  }

  function initDraft() {
    draftEnv = (serverConfig.env || []).map(function(envEntry) {
      var draft = { key: envEntry.key };
      if (envEntry.secret) {
        draft.secretAction = 'keep';
      } else {
        draft.value = envEntry.value;
      }
      return draft;
    });
    draftDefaultModel = serverConfig.defaultModel || '';
    draftChannels = (serverConfig.channels || []).map(function(channel) {
      return {
        id: channel.id,
        name: channel.name || '',
        baseUrl: channel.baseUrl,
        apiKeyAction: 'keep',
        disableCooldown: channel.disableCooldown === true,
      };
    });
    draftModels = (serverConfig.models || []).map(function(route) {
      return {
        canonicalModel: route.canonicalModel,
        channelIds: route.channelIds.slice(),
      };
    });
    draftAliases = JSON.parse(JSON.stringify(serverConfig.aliases || {}));
  }

  function normalizeEnvForDirty(entry) {
    if (entry.secretAction) {
      var normalized = { key: entry.key, secretAction: entry.secretAction };
      if (entry.secretAction === 'replace' && entry.value !== undefined) {
        normalized.value = entry.value;
      }
      return normalized;
    }
    return { key: entry.key, value: entry.value };
  }

  function normalizeChannelForDirty(channel) {
    var normalized = { id: channel.id, name: channel.name || '', baseUrl: channel.baseUrl, apiKeyAction: channel.apiKeyAction, disableCooldown: channel.disableCooldown === true };
    if (channel.apiKeyAction === 'replace' && channel.apiKeyValue !== undefined) {
      normalized.apiKeyValue = channel.apiKeyValue;
    }
    return normalized;
  }

  function normalizeModelForDirty(route) {
    return {
      canonicalModel: route.canonicalModel,
      channelIds: route.channelIds.slice(),
    };
  }

  function checkDirty() {
    if (!serverConfig) return;
    var envChanged = JSON.stringify(draftEnv.map(normalizeEnvForDirty)) !== JSON.stringify((serverConfig.env || []).map(function(entry) {
      return entry.secret ? { key: entry.key, secretAction: 'keep' } : { key: entry.key, value: entry.value };
    }));
    var defaultModelChanged = draftDefaultModel !== (serverConfig.defaultModel || '');
    var channelsChanged = JSON.stringify(draftChannels.map(normalizeChannelForDirty)) !== JSON.stringify((serverConfig.channels || []).map(function(channel) {
      return { id: channel.id, name: channel.name || '', baseUrl: channel.baseUrl, apiKeyAction: 'keep', disableCooldown: channel.disableCooldown === true };
    }));
    var modelsChanged = JSON.stringify(draftModels.map(normalizeModelForDirty)) !== JSON.stringify((serverConfig.models || []).map(function(route) {
      return { canonicalModel: route.canonicalModel, channelIds: route.channelIds.slice() };
    }));
    var aliasesChanged = JSON.stringify(draftAliases) !== JSON.stringify(serverConfig.aliases || {});
    setDirty(envChanged || defaultModelChanged || channelsChanged || modelsChanged || aliasesChanged);
  }

  function buildDraftPayload() {
    return {
      env: draftEnv.map(function(entry) {
        var payload = { key: entry.key };
        if (entry.secretAction) {
          payload.secretAction = entry.secretAction;
          if (entry.secretAction === 'replace' && entry.value !== undefined) payload.value = entry.value;
        } else {
          payload.value = entry.value;
        }
        return payload;
      }),
      defaultModel: draftDefaultModel,
      channels: draftChannels.map(function(channel) {
        var payload = {
          id: channel.id,
          name: channel.name,
          baseUrl: channel.baseUrl,
          apiKeyAction: channel.apiKeyAction,
          disableCooldown: channel.disableCooldown === true,
        };
        if (channel.apiKeyAction === 'replace' && channel.apiKeyValue !== undefined) {
          payload.apiKeyValue = channel.apiKeyValue;
        }
        return payload;
      }),
      models: draftModels.map(function(route) {
        return {
          canonicalModel: route.canonicalModel,
          channelIds: route.channelIds.slice(),
        };
      }),
      aliases: JSON.parse(JSON.stringify(draftAliases)),
    };
  }

  function clearActionResult() {
    actionResult.textContent = '';
    actionResult.className = '';
  }

  function showActionResult(text, isError) {
    clearActionResult();
    actionResult.className = isError ? 'notice notice-error' : 'notice notice-success';
    actionResult.textContent = text;
  }

  function showValidationResult(body) {
    validationResult.innerHTML = '';
    if (body.valid) {
      var success = document.createElement('div');
      success.className = 'validation-result notice notice-success validation-valid';
      success.textContent = '草稿校验通过。';
      if (body.warnings && body.warnings.length > 0) {
        success.textContent += ' 警告：' + body.warnings.join('; ');
      }
      validationResult.appendChild(success);
      return;
    }

    var failure = document.createElement('div');
    failure.className = 'validation-result notice notice-error validation-invalid';
    failure.textContent = '校验错误：';
    var list = document.createElement('ul');
    list.className = 'validation-errors';
    (body.errors || []).forEach(function(error) {
      var item = document.createElement('li');
      item.textContent = error;
      list.appendChild(item);
    });
    failure.appendChild(list);
    validationResult.appendChild(failure);
  }

  function addChannel() {
    document.getElementById('channel-search').value = '';
    draftChannels.push({ id: 'new-channel-' + Date.now(), name: '', baseUrl: 'https://provider.example', apiKeyAction: 'replace', apiKeyValue: '', disableCooldown: false });
    renderChannels();
    renderModelRoutes();
    checkDirty();
    var input = document.querySelector('#channels-table .channel-row:last-child input');
    input.focus();
    input.select();
  }

  function addModelRoute() {
    draftModels.push({ canonicalModel: 'new-model-' + Date.now(), channelIds: [] });
    selectedModelIdx = draftModels.length - 1;
    renderModelRoutes();
    checkDirty();
  }

  function addAlias() {
    var alias = 'new-alias-' + Date.now();
    draftAliases[alias] = '';
    renderAliases();
    checkDirty();
  }

  async function loadRuntimeStats() {
    try {
      var res = await fetch('/admin/stats');
      if (!res.ok) return;
      var data = await res.json();
      document.getElementById('usage-nav').hidden = data.usageAvailable !== true;
      if (typeof data.activeRequests === 'number') {
        serverMeta.activeRequests = data.activeRequests;
        renderTopbarSummary();
      }
    } catch (error) {
      void error;
    }
  }

  async function loadConfig() {
    setStatus('加载中…');
    try {
      var res = await fetch('/admin/config');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (!data.ok) throw new Error((data.error && data.error.message) || '未知错误');
      serverConfig = data.config;
      serverMeta = { runtimeVersion: data.runtimeVersion, restartRequiredFields: data.restartRequiredFields || [], activeRequests: null };
      initDraft();
      render();
      await loadRuntimeStats();
      setStatus('已连接 · 配置已加载');
    } catch (error) {
      setStatus('错误：' + error.message, true);
    }
  }

  document.getElementById('default-model-input').addEventListener('input', function() {
    draftDefaultModel = this.value;
    checkDirty();
  });
  document.getElementById('btn-add-channel').addEventListener('click', addChannel);
  document.getElementById('btn-add-model-route').addEventListener('click', addModelRoute);
  document.getElementById('btn-add-alias').addEventListener('click', addAlias);
  document.getElementById('btn-validate').addEventListener('click', async function() {
    validationResult.innerHTML = '<div class="loading">校验中…</div>';
    try {
      var res = await fetch('/admin/config/validate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildDraftPayload()),
      });
      showValidationResult(await res.json());
    } catch (error) {
      validationResult.innerHTML = '<div class="validation-result notice notice-error validation-invalid">' + esc(error.message) + '</div>';
    }
  });

  document.getElementById('btn-save').addEventListener('click', async function() {
    clearActionResult();
    try {
      var res = await fetch('/admin/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildDraftPayload()),
      });
      var data = await res.json();
      if (data.ok) {
        showActionResult('已保存并重载（v' + data.runtimeVersion + ')', false);
        await loadConfig();
      } else {
        showActionResult('保存失败：' + ((data.error && data.error.message) || '未知错误'), true);
      }
    } catch (error) {
      showActionResult('保存出错：' + error.message, true);
    }
  });

  document.getElementById('btn-reload').addEventListener('click', async function() {
    clearActionResult();
    try {
      var res = await fetch('/admin/config/reload', { method: 'POST' });
      var data = await res.json();
      if (data.ok) {
        showActionResult('已重载（v' + data.runtimeVersion + ')', false);
        await loadConfig();
      } else {
        showActionResult('重载失败：' + ((data.error && data.error.message) || '未知错误'), true);
      }
    } catch (error) {
      showActionResult('重载出错：' + error.message, true);
    }
  });

  document.getElementById('btn-rollback').addEventListener('click', async function() {
    clearActionResult();
    try {
      var res = await fetch('/admin/config/rollback', { method: 'POST' });
      var data = await res.json();
      if (data.ok) {
        showActionResult('已回滚，恢复字段：' + (data.restored || []).join(', '), false);
        await loadConfig();
      } else {
        showActionResult('回滚失败：' + ((data.error && data.error.message) || '未知错误'), true);
      }
    } catch (error) {
      showActionResult('回滚出错：' + error.message, true);
    }
  });

  window.addEventListener('hashchange', showView);
  document.getElementById('channel-search').addEventListener('input', filterChannels);
  document.getElementById('env-search').addEventListener('input', filterEnvironment);
  window.addEventListener('beforeunload', function(event) {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
  showView();
  loadConfig();
})();
