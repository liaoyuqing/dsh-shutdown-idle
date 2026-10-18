// dsh-shutdown-idle — 浏览器半（手写 CJS-table bundle，注册协议与打包产物一致）。
// 两处界面：设置页「会话结束后关机」分区（开关 + 参数 + 状态），
// 以及 shell.overlay 上的浮层卡片（可拖动，开启后显示阶段与倒计时，带「取消」）。
// 数据面走同源 fetch 到宿主插件 /dsh-shutdown/api/*。
// 全文件防御式 try/catch：任一步失败只损失本卡片，不影响应用启动。
window.__ModuleLoader__.load({
  id: "dsh-shutdown-idle",
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;
    try {
      var React = require("react");
      var STATE_API = "/dsh-shutdown/api/state";
      var CONFIG_API = "/dsh-shutdown/api/config";
      var CANCEL_API = "/dsh-shutdown/api/cancel";
      var POSITION_KEY = "dsh.shutdown-idle.pill.position";
      // 拖动阈值：超过它才算拖拽，避免点击标题也顺手挪一下卡片。
      var DRAG_THRESHOLD_PX = 4;
      // 拖动过程中卡片至少要留在视口里的边距（像素）。
      var KEEP_VISIBLE_PX = 8;
      // 只用主题实际提供的令牌（--dsw-alias-*）；皮肤可能只定义其中一部分，
      // 因此每处都带一个中性回退值。主按钮的前景色取背景色令牌：
      // 强调色与页面底色总是互为对比，浅色/深色皮肤都不会出现同色文字。
      var S = {
        root: { fontSize: "13px", lineHeight: 1.6, padding: "16px 20px 24px", maxWidth: "720px", color: "var(--dsw-alias-label-primary, inherit)" },
        title: { fontSize: "15px", fontWeight: 600, margin: "0 0 2px" },
        sub: { fontSize: "12px", opacity: 0.65, margin: "0 0 12px" },
        panel: { padding: "10px 12px", borderRadius: "8px", background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))", margin: "0 0 12px", whiteSpace: "pre-wrap" },
        row: { display: "flex", gap: "12px", alignItems: "center", flexWrap: "wrap", margin: "8px 0" },
        field: { display: "flex", gap: "6px", alignItems: "center" },
        label: { fontSize: "12px", opacity: 0.75 },
        input: { background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.08))", color: "inherit", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.3))", borderRadius: "6px", padding: "3px 8px", font: "inherit", boxSizing: "border-box" },
        btn: { background: "var(--dsw-alias-bg-layer-2, rgba(127,127,127,.12))", color: "inherit", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))", borderRadius: "6px", padding: "4px 12px", font: "inherit", cursor: "pointer" },
        primary: { background: "var(--dsw-alias-brand-primary, #2f6feb)", color: "var(--dsw-alias-bg-base, #fff)", border: "1px solid var(--dsw-alias-brand-primary, #2f6feb)", borderRadius: "6px", padding: "4px 14px", font: "inherit", cursor: "pointer", fontWeight: 600 },
        ok: { fontSize: "12px", color: "var(--dsw-alias-state-success-primary, #57ab5a)", minHeight: "20px" },
        err: { fontSize: "12px", color: "var(--dsw-alias-state-error-primary, #e0605f)", minHeight: "20px" },
        gate: { padding: "10px 12px", borderRadius: "8px", border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.28))", margin: "0 0 12px" },
        gateTitle: { fontSize: "12px", fontWeight: 600, margin: "0 0 6px" },
        gateRow: { display: "flex", gap: "8px", alignItems: "center", margin: "4px 0" },
        gateFixed: { fontSize: "12px", opacity: 0.6 },
        check: { display: "flex", gap: "6px", alignItems: "center", fontSize: "12px", opacity: 0.85 },
        hint: { fontSize: "12px", opacity: 0.6, marginTop: "10px" },
        pill: {
          position: "fixed", right: "16px", bottom: "16px", zIndex: 40, pointerEvents: "auto",
          minWidth: "230px", maxWidth: "320px", padding: "10px 12px", borderRadius: "10px",
          background: "var(--dsw-alias-bg-overlay, rgba(30,33,39,.96))", color: "var(--dsw-alias-label-primary, #e6e6e6)",
          border: "1px solid var(--dsw-alias-border-l2, rgba(127,127,127,.35))", boxShadow: "0 6px 24px rgba(0,0,0,.35)",
          fontSize: "12px", lineHeight: 1.6,
        },
        pillTitle: { fontWeight: 600, marginBottom: "2px" },
        pillHandle: { cursor: "move", userSelect: "none", touchAction: "none", marginBottom: "2px" },
      };

      /**
       * 读取持久化的浮窗位置（视口坐标）。任何失败都当作「没有记录」。
       * @returns {{left: number, top: number}|null}
       */
      function readPosition() {
        try {
          var raw = window.localStorage.getItem(POSITION_KEY);
          if (raw === null) return null;
          var value = JSON.parse(raw);
          if (value === null || typeof value !== "object") return null;
          if (typeof value.left !== "number" || typeof value.top !== "number") return null;
          if (!isFinite(value.left) || !isFinite(value.top)) return null;
          return { left: value.left, top: value.top };
        } catch (e) { return null; }
      }
      /** 写入浮窗位置；localStorage 不可用（隐私模式等）时静默跳过。 */
      function writePosition(pos) {
        try { window.localStorage.setItem(POSITION_KEY, JSON.stringify(pos)); } catch (e) { /* 不阻塞拖动 */ }
      }
      /**
       * 把位置夹回视口内：保证卡片始终有一部分可见、拖不出屏幕。
       * @param pos - 期望的左上角视口坐标。
       * @param card - 卡片尺寸（用于换算右/下边界）。
       */
      function clampPosition(pos, card) {
        var maxLeft = Math.max(KEEP_VISIBLE_PX, window.innerWidth - card.width - KEEP_VISIBLE_PX);
        var maxTop = Math.max(KEEP_VISIBLE_PX, window.innerHeight - card.height - KEEP_VISIBLE_PX);
        return {
          left: Math.min(Math.max(KEEP_VISIBLE_PX, pos.left), maxLeft),
          top: Math.min(Math.max(KEEP_VISIBLE_PX, pos.top), maxTop),
        };
      }

      /**
       * 可拖动浮窗的位置状态：按下标题开始拖，移动跟手，松手（或取消）落定。
       * 位置以视口坐标存进 localStorage，下次打开浮窗时恢复；尺寸变化时夹回视口内。
       * @param defaultPos - 没有历史记录时使用的初始位置（视口坐标）。
       * @returns {{pos: object, dragging: boolean, onHandlePointerDown: function, nodeRef: object}}
       */
      function useDraggable(defaultPos) {
        var nodeRef = React.useRef(null);
        var posPair = React.useState(function () {
          var saved = readPosition();
          return saved === null ? defaultPos : saved;
        });
        var pos = posPair[0]; var setPos = posPair[1];
        var dragPair = React.useState(false);
        var dragging = dragPair[0]; var setDragging = dragPair[1];
        // 拖动现场：起点指针位置、起点卡片位置、阈值是否已过、指针 id。
        var dragRef = React.useRef(null);

        // 尺寸/窗口变化后重新夹一次，避免卡片被留在视口外（例如改了分辨率）。
        React.useEffect(function () {
          function onResize() {
            var node = nodeRef.current;
            if (node === null) return;
            var rect = node.getBoundingClientRect();
            setPos(function (current) {
              var next = clampPosition(current, { width: rect.width, height: rect.height });
              return next.left === current.left && next.top === current.top ? current : next;
            });
          }
          window.addEventListener("resize", onResize);
          return function () { window.removeEventListener("resize", onResize); };
        }, []);

        /**
         * 标题上的按下：只认左键；记录起点并捕获指针，后续移动由 window 上的
         * move/up 监听处理（指针中途移出卡片也不会丢事件）。
         */
        function onHandlePointerDown(ev) {
          if (ev.button !== 0 || ev.target !== null && typeof ev.target.closest === "function" && ev.target.closest("button")) return;
          var node = nodeRef.current;
          if (node === null) return;
          dragRef.current = {
            pointerId: ev.pointerId, startX: ev.clientX, startY: ev.clientY,
            originLeft: pos.left, originTop: pos.top, moved: false,
          };
          try { node.setPointerCapture(ev.pointerId); } catch (e) { /* 某些环境不支持捕获，退回 window 监听 */ }
          setDragging(true);
        }

        React.useEffect(function () {
          if (!dragging) return;
          function onMove(ev) {
            var drag = dragRef.current;
            if (drag === null || drag.pointerId !== ev.pointerId) return;
            var dx = ev.clientX - drag.startX;
            var dy = ev.clientY - drag.startY;
            if (!drag.moved && Math.abs(dx) < DRAG_THRESHOLD_PX && Math.abs(dy) < DRAG_THRESHOLD_PX) return;
            drag.moved = true;
            var node = nodeRef.current;
            var rect = node === null ? { width: 230, height: 80 } : node.getBoundingClientRect();
            setPos(clampPosition({ left: drag.originLeft + dx, top: drag.originTop + dy }, { width: rect.width, height: rect.height }));
          }
          function onUp(ev) {
            var drag = dragRef.current;
            if (drag !== null && drag.pointerId !== ev.pointerId) return;
            dragRef.current = null;
            setDragging(false);
            var node = nodeRef.current;
            if (node !== null && typeof node.releasePointerCapture === "function") {
              try { node.releasePointerCapture(ev.pointerId); } catch (e) { /* 已自动释放 */ }
            }
            setPos(function (current) { writePosition(current); return current; });
          }
          function onCancel(ev) {
            var drag = dragRef.current;
            if (drag === null || drag.pointerId !== ev.pointerId) return;
            dragRef.current = null;
            setDragging(false);
          }
          window.addEventListener("pointermove", onMove, { passive: true });
          window.addEventListener("pointerup", onUp);
          window.addEventListener("pointercancel", onCancel);
          return function () {
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            window.removeEventListener("pointercancel", onCancel);
          };
        }, [dragging]);

        return { pos: pos, dragging: dragging, onHandlePointerDown: onHandlePointerDown, nodeRef: nodeRef };
      }

      /** 读 JSON 响应；空体或非 JSON 一律抛错，避免把 HTML 错误页当数据。 */
      function readJson(res) {
        return res.text().then(function (text) {
          var data = null;
          try { data = JSON.parse(text); } catch (e) { data = null; }
          if (data === null) throw new Error("HTTP " + res.status + " " + (text.length === 0 ? "空响应体" : text.slice(0, 80)));
          return data;
        });
      }
      function getState() {
        return fetch(STATE_API, { credentials: "same-origin", cache: "no-store" }).then(readJson);
      }
      function post(path, body) {
        return fetch(path, {
          method: "POST", credentials: "same-origin", cache: "no-store",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body || {}),
        }).then(readJson);
      }

      /**
       * 轮询宿主状态。静止阶段放慢到 3 秒，空闲确认/倒计时/进行中 1 秒。
       * @returns {{plan: object|null, error: string}} 宿主状态与最近一次失败原因。
       */
      function usePlan() {
        var pair = React.useState(null);
        var plan = pair[0]; var setPlan = pair[1];
        var errorPair = React.useState("");
        var error = errorPair[0]; var setError = errorPair[1];
        var latest = React.useRef(null);
        React.useEffect(function () {
          var stopped = false;
          var timer = null;
          function schedule() {
            var current = latest.current;
            var slow = current !== null && (current.phase === "off" || current.phase === "fired" || current.phase === "waiting");
            timer = setTimeout(step, slow ? 3000 : 1000);
          }
          function step() {
            if (stopped) return;
            getState().then(function (data) {
              if (stopped) return;
              latest.current = data;
              setPlan(data);
              setError("");
            }).catch(function (e) {
              if (stopped) return;
              setError(String((e && e.message) || e));
            }).then(function () { if (!stopped) schedule(); });
          }
          step();
          return function () { stopped = true; if (timer !== null) clearTimeout(timer); };
        }, []);
        return { plan: plan, error: error };
      }

      /** 阶段与倒计时的单行描述。 */
      function describe(plan) {
        var text = plan.phaseLabel || plan.phase;
        var seconds = Math.max(0, Math.round((plan.remainingMs || 0) / 1000));
        if (plan.phase === "settle" || plan.phase === "countdown") {
          text += "：" + seconds + " 秒后执行「" + (plan.actionLabel || plan.action) + "」";
        } else if (plan.phase === "busy") {
          text += "（" + plan.running.length + " 个会话" + (plan.jobs > 0 ? "、" + plan.jobs + " 个后台任务" : "") + "）";
        }
        return text;
      }

      function Section() {
        var st = usePlan();
        var plan = st.plan;
        var draftPair = React.useState(null);
        var draft = draftPair[0]; var setDraft = draftPair[1];
        var notePair = React.useState("");
        var note = notePair[0]; var setNote = notePair[1];
        var busyPair = React.useState(false);
        var busy = busyPair[0]; var setBusy = busyPair[1];

        function send(body, okText) {
          setBusy(true);
          post(CONFIG_API, body).then(function (res) {
            setBusy(false);
            if (res && res.ok) { setNote(okText || "已生效"); setDraft(null); }
            else setNote("失败：" + ((res && res.error) || "未知错误"));
          }).catch(function (e) { setBusy(false); setNote("失败：" + String((e && e.message) || e)); });
        }
        function edit(field, value) {
          setDraft(function () {
            var base = draft !== null ? Object.assign({}, draft) : {
              action: plan ? plan.action : "shutdown",
              settleSeconds: plan ? plan.settleSeconds : 20,
              countdownSeconds: plan ? plan.countdownSeconds : 60,
              requireActivity: plan ? plan.requireActivity : true,
              considerJobs: plan ? plan.considerJobs : true,
            };
            base[field] = value;
            return base;
          });
        }

        try {
          var e = React.createElement;
          var children = [];
          children.push(e("div", { style: S.title, key: "t" }, "会话结束后关机"));
          children.push(e("div", { style: S.sub, key: "s" },
            "开启后监视所有会话：没有任何会话在跑（可选把后台任务也算作占用）并保持空闲一段时间，就执行所选动作。倒计时期间任何会话重新开始，或点「取消」，都会撤销这次动作。"));

          if (plan === null) {
            children.push(e("div", { style: S.panel, key: "p" }, st.error === "" ? "加载中…" : ("宿主接口异常：" + st.error)));
          } else {
            var shortId = function (id) {
              var text = String(id);
              return text.length <= 8 ? text : "…" + text.slice(-6);
            };
            var status = plan.phase === "off" ? "未开启" : describe(plan) + (plan.enabled ? "（已开启）" : "");
            var lines = [
              "状态：" + status,
              "动作：" + (plan.actionLabel || plan.action) + "（" + (plan.actionHint || "") + "）",
              "参数：空闲确认 " + plan.settleSeconds + " 秒 → 倒计时 " + plan.countdownSeconds + " 秒",
              "条件：需要先有会话运行 " + (plan.requireActivity ? "是" : "否")
                + " ｜ 后台任务算占用 " + (plan.considerJobs ? "是" : "否"),
              "运行中会话：" + (plan.known
                ? (plan.running.length ? plan.running.length + " 个（" + plan.running.map(shortId).join("、") + "）" : "无")
                : "无法确认（按不空闲处理）")
                + " ｜ 运行中后台任务：" + plan.jobs,
            ];
            if (plan.lastExecution) {
              lines.push("上次执行：" + new Date(plan.lastExecution.at).toLocaleString() + " · "
                + (plan.lastExecution.ok ? "成功" : "失败") + " · " + plan.lastExecution.detail);
            }
            if (plan.error) lines.push("错误：" + plan.error);
            children.push(e("div", { style: S.panel, key: "p" }, lines.join("\n")));

            children.push(e("div", { style: S.row, key: "switch" },
              e("button", {
                style: plan.enabled ? S.btn : S.primary, disabled: busy,
                onClick: function () { send({ enabled: !plan.enabled }, plan.enabled ? "已关闭" : "已开启，等所有会话结束后执行"); },
              }, plan.enabled ? "关闭" : "开启"),
              e("button", {
                style: S.btn, disabled: busy || !plan.enabled,
                onClick: function () { send({ enabled: false }, "已取消并关闭"); },
              }, "取消倒计时并关闭")));

            var rows = draft !== null ? draft : {
              action: plan.action, settleSeconds: plan.settleSeconds, countdownSeconds: plan.countdownSeconds,
              requireActivity: plan.requireActivity, considerJobs: plan.considerJobs,
            };
            var dirty = draft !== null;
            var options = (plan.actions || []).map(function (item) {
              return e("option", { key: item.value, value: item.value }, item.label + "（" + item.hint + "）");
            });
            var numberInput = function (field, value, key) {
              return e("input", {
                key: key, type: "number", min: "0", max: "3600", style: Object.assign({}, S.input, { width: "84px" }),
                value: value, disabled: busy,
                onChange: function (ev) { edit(field, Math.round(Number(ev.target.value))); },
              });
            };
            children.push(e("div", { style: S.row, key: "cfg-action" },
              e("span", { style: S.label }, "动作"),
              e("select", { style: S.input, value: rows.action, disabled: busy, onChange: function (ev) { edit("action", ev.target.value); } }, options)));
            children.push(e("div", { style: S.row, key: "cfg-times" },
              e("span", { style: S.field }, e("span", { style: S.label }, "空闲确认（秒）"), numberInput("settleSeconds", rows.settleSeconds, "settle")),
              e("span", { style: S.field }, e("span", { style: S.label }, "倒计时（秒）"), numberInput("countdownSeconds", rows.countdownSeconds, "countdown"))));
            children.push(e("div", { style: S.gate, key: "gates" },
              e("div", { style: S.gateTitle, key: "gt" }, "什么算「还在忙」"),
              e("div", { style: S.gateRow, key: "g-fixed" },
                e("span", { style: S.gateFixed }, "有会话（Agent 回合）在跑 —— 固定算忙，不能关闭")),
              e("div", { style: S.gateRow, key: "g-flag" },
                e("label", { style: S.check },
                  e("input", { type: "checkbox", checked: !!rows.considerJobs, disabled: busy, onChange: function (ev) { edit("considerJobs", ev.target.checked); } }),
                  " 有后台任务在跑（后台任务 " + plan.jobs + " 个在跑）也算忙 —— 关掉后就不再检测后台任务")),
              e("div", { style: S.gateRow, key: "g-activity" },
                e("label", { style: S.check },
                  e("input", { type: "checkbox", checked: !!rows.requireActivity, disabled: busy, onChange: function (ev) { edit("requireActivity", ev.target.checked); } }),
                  " 关闭前必须先观察到会话运行过（防止刚开启就执行）")),
              dirty ? e("div", { style: S.row, key: "cfg-save" },
                e("button", { style: S.primary, disabled: busy, onClick: function () { send(rows, "已保存并立即生效（已开启状态下重新计时）"); } }, "保存"),
                e("button", { style: S.btn, disabled: busy, onClick: function () { setDraft(null); setNote(""); } }, "放弃修改")) : null));
          }

          if (note !== "") children.push(e("div", { style: note.indexOf("失败") >= 0 ? S.err : S.ok, key: "n" }, note));
          if (st.error !== "" && plan !== null) children.push(e("div", { style: S.err, key: "e" }, "宿主接口异常：" + st.error + "（若插件刚重载，稍候会自动恢复）"));
          children.push(e("div", { style: S.hint, key: "h" },
            "判据：只有 Agent 处于 running 才算会话进行中（与 dshmarket 更新守卫一致）；拿不到 agents 服务时按「不空闲」处理。"
            + "「有后台任务在跑也算忙」是配置项（considerJobs），关掉后完全不再检测后台任务。"
            + "「必须观察到会话运行过」可以防止刚开启没有任何任务时就执行动作。开关状态不跨宿主重启保持（防开机误关机），参数保存到 "
            + (plan ? plan.settingsPath : "<DSH_HOME>/dsh-shutdown-idle/settings.json") + "。"));
          return e("div", { style: S.root }, children);
        } catch (error) {
          return React.createElement("div", { style: S.err }, "关机界面渲染失败：" + String((error && error.message) || error));
        }
      }

      function Pill() {
        var st = usePlan();
        var plan = st.plan;
        // 默认停在右下角（与浮层默认位姿一致）；拖动后按 localStorage 里的位置恢复。
        var drag = useDraggable({ left: Math.max(16, window.innerWidth - 336), top: Math.max(16, window.innerHeight - 160) });
        try {
          if (plan === null || !plan.enabled) return null;
          var e = React.createElement;
          var style = Object.assign({}, S.pill, { left: drag.pos.left + "px", top: drag.pos.top + "px", right: "auto", bottom: "auto" });
          if (drag.dragging) style.opacity = 0.85;
          var children = [
            e("div", {
              key: "handle", style: S.pillHandle,
              onPointerDown: drag.onHandlePointerDown,
              title: "按住拖动可移动此卡片",
            },
              e("div", { key: "t", style: S.pillTitle }, "会话结束后执行：" + (plan.actionLabel || plan.action)),
              e("div", { key: "d" }, describe(plan))),
          ];
          if (plan.phase === "settle" || plan.phase === "countdown") {
            children.push(e("div", { key: "b", style: { marginTop: "6px" } },
              e("button", { style: Object.assign({}, S.btn, { padding: "2px 10px" }), onClick: function () { post(CANCEL_API, {}).catch(function () { return undefined; }); } }, "取消")));
          }
          if (st.error !== "") children.push(e("div", { key: "e", style: S.err }, "状态不可用：" + st.error));
          return e("div", { ref: drag.nodeRef, style: style }, children);
        } catch (error) {
          return React.createElement("div", { style: S.err }, String((error && error.message) || error));
        }
      }

      function apply(ctx) {
        try {
          ctx.slots.inject("settings.section", function () {
            try {
              return ctx.slots.register(
                { name: "settings.section", id: "shutdown-idle", order: 65, label: "会话结束后关机" },
                Section,
              );
            } catch (e) { console.error("[dsh-shutdown-idle] settings section register failed", e); return undefined; }
          });
        } catch (e) { console.error("[dsh-shutdown-idle] settings section inject failed", e); }
        try {
          ctx.slots.inject("shell.overlay", function () {
            try {
              return ctx.slots.register({ name: "shell.overlay", id: "shutdown-idle-pill", order: 20 }, Pill);
            } catch (e) { console.error("[dsh-shutdown-idle] overlay register failed", e); return undefined; }
          });
        } catch (e) { console.error("[dsh-shutdown-idle] overlay inject failed", e); }
      }

      exports.inject = ["slots"];
      exports.apply = apply;
    } catch (error) {
      console.error("[dsh-shutdown-idle] factory failed", error);
    }
    return module.exports;
  },
});