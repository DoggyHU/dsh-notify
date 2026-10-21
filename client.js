/**
 * Browser half of dsh-notify — one settings page where the two sounds are
 * picked and auditioned.
 *
 * Constraints honoured (cordis-plugin-development skill, reference:
 * `references/ui-plugin.md`):
 *   - the ModuleLoader factory id equals the package name;
 *   - the factory body is side-effect free — dictionaries, the RPC handle and
 *     the slot registration all happen in `apply`, and the dictionary
 *     registration is torn down by a cleanup;
 *   - styles use host theme tokens only, and no Harness Client package is
 *     imported (React comes from the browser module table);
 *   - the plugin never touches the app root or appends to `document.body`.
 *
 * The Host half answers `/notify` with `get`, `set` and `preview`; `preview`
 * plays a stock `.wav` on this machine so every row can be auditioned before
 * it is chosen.
 */

window.__ModuleLoader__.load({
  id: 'dsh-notify',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useState } = React

    /** Locale namespace and the Host route owned by this package. */
    const NS = 'dsh-notify'
    const ROUTE = '/api/notify.config'
    /** Where the page sits among the shipped settings sections. */
    const ORDER = 12

    const zh = {
      title: '任务提示音',
      intro:
        '需要你确认、或者活干完的时候，用 Windows 自己的声音提醒你。声音由 DSH 本机进程播放，所以页面在后台、切到别的窗口、甚至标签被静音，都还听得见。',
      enabled: '启用提示音',
      enabledHint: '关掉后完全不出声（设置页本身仍然可用）',
      attention: '需要你确认时',
      done: '任务完成时',
      current: '当前',
      audition: '试听',
      customLabel: '自定义 wav',
      customPlaceholder: '绝对路径，例如 D:\\Sounds\\ping.wav',
      use: '使用',
      advanced: '进阶',
      muteDelegated: '子代理 / 团队成员完成时也出声',
      muteDelegatedHint: '默认关闭：一次团队协作会响很多次，只有你正在看的会话才该响',
      minGap: '两声之间的最小间隔（毫秒）',
      settle: '刚提示过「需要确认」后，多少毫秒内不再报完成',
      missing: '找不到这个文件',
      saved: '已保存',
      loading: '读取配置中…',
      failed: '读取配置失败',
      noConnection: '网页与后台的连接不可用，暂时无法读写配置',
      hostChannelMissing:
        '后台的 /api/notify.config 路由没注册上（HTTP 404/405）。提示音本身不受影响；原因写在 storages\\dsh-notify.log 里',
      configFile: '配置文件',
      stockCount: '个 Windows 自带音效',
    }

    const en = {
      title: 'Task sounds',
      intro:
        'Plays a Windows sound when DSH needs you or finishes work. The Host process plays it, so it is audible while this page is in the background, another window is in front, or the tab is muted.',
      enabled: 'Enable sounds',
      enabledHint: 'While off, nothing is played (this page still works)',
      attention: 'When you are needed',
      done: 'When work finishes',
      current: 'Current',
      audition: 'Preview',
      customLabel: 'Custom wav',
      customPlaceholder: 'Absolute path, e.g. D:\\Sounds\\ping.wav',
      use: 'Use',
      advanced: 'Advanced',
      muteDelegated: 'Also play when a subagent or teammate finishes',
      muteDelegatedHint: 'Off by default: one team run finishes many times',
      minGap: 'Minimum gap between two sounds (ms)',
      settle: 'After an attention sound, silence a finish for (ms)',
      missing: 'File not found',
      saved: 'Saved',
      loading: 'Loading configuration…',
      failed: 'Could not read the configuration',
      noConnection: 'The page cannot reach the Host right now',
      hostChannelMissing:
        'The Host never registered its /api/notify.config route (HTTP 404/405). Sounds are unaffected; the reason is in storages\\dsh-notify.log',
      configFile: 'Config file',
      stockCount: 'stock Windows sounds',
    }

    /** Translate through the locale service, falling back to the bundled copy. */
    function makeT(bind) {
      return (key) => {
        if (typeof bind === 'function') {
          try {
            const value = bind(key)
            if (typeof value === 'string' && value && value !== key) return value
          } catch {
            /* a missing dictionary must not blank the page */
          }
        }
        return zh[key] ?? key
      }
    }

    // ── styles ───────────────────────────────────────────────────────────────
    // Theme tokens are the only shared styling dependency; every name below is
    // one the live Theme inspection lists.

    const styles = {
      page: { display: 'flex', flexDirection: 'column', gap: 22, fontFamily: 'inherit' },
      intro: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' },
      block: { display: 'flex', flexDirection: 'column', gap: 8 },
      blockTitle: {
        fontSize: 13,
        lineHeight: '18px',
        fontWeight: 600,
        color: 'var(--dsw-alias-label-primary)',
      },
      current: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' },
      card: {
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: 8,
        background: 'var(--dsw-alias-bg-layer-1)',
        overflow: 'hidden',
      },
      list: { maxHeight: 176, overflowY: 'auto' },
      row: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 10px',
        fontSize: 12,
        lineHeight: '18px',
        cursor: 'pointer',
      },
      dot: { flex: '0 0 auto', width: 12, textAlign: 'center' },
      name: {
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        color: 'var(--dsw-alias-label-primary)',
      },
      play: {
        appearance: 'none',
        flex: '0 0 auto',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'transparent',
        color: 'var(--dsw-alias-label-secondary)',
        borderRadius: 6,
        padding: '1px 8px',
        fontSize: 11,
        lineHeight: '16px',
        cursor: 'pointer',
        fontFamily: 'inherit',
      },
      footer: {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        borderTop: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      input: {
        flex: 1,
        minWidth: 0,
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 6,
        padding: '3px 8px',
        fontSize: 12,
        lineHeight: '18px',
        fontFamily: 'inherit',
      },
      number: {
        width: 78,
        appearance: 'none',
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 6,
        padding: '3px 8px',
        fontSize: 12,
        lineHeight: '18px',
        fontFamily: 'inherit',
      },
      primary: {
        appearance: 'none',
        border: '1px solid transparent',
        background: 'var(--dsw-alias-bg-base)',
        color: 'var(--dsw-alias-label-primary)',
        borderRadius: 6,
        padding: '3px 10px',
        fontSize: 12,
        lineHeight: '18px',
        cursor: 'pointer',
        fontFamily: 'inherit',
        flex: '0 0 auto',
      },
      toggle: { display: 'flex', alignItems: 'center', gap: 8 },
      checkbox: { accentColor: 'var(--dsw-alias-brand-primary)', margin: 0 },
      toggleText: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-primary)' },
      hint: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-label-secondary)' },
      statusOk: { fontSize: 11, lineHeight: '16px', color: 'var(--dsw-alias-state-success-primary)' },
      statusError: {
        fontSize: 11,
        lineHeight: '16px',
        color: 'var(--dsw-alias-state-error-primary)',
      },
      footerNote: {
        fontSize: 11,
        lineHeight: '16px',
        color: 'var(--dsw-alias-label-secondary)',
        wordBreak: 'break-all',
      },
    }

    /** One toggle row. */
    function Toggle({ checked, onChange, label, hint }) {
      return h(
        'div',
        { style: styles.block },
        h(
          'label',
          { style: styles.toggle },
          h('input', {
            type: 'checkbox',
            style: styles.checkbox,
            checked: Boolean(checked),
            onChange: (event) => onChange(event.target.checked),
          }),
          h('span', { style: styles.toggleText }, label),
        ),
        hint ? h('div', { style: { ...styles.hint, paddingLeft: 24 } }, hint) : null,
      )
    }

    /**
     * One sound slot: the stock list with a preview button per row, plus a
     * custom path. Picking a row selects it and plays it, so choosing is the
     * same gesture as auditioning.
     */
    function SoundBlock({
      t,
      title,
      names,
      value,
      onPick,
      onAudition,
      custom,
      onCustomChange,
      onCustomUse,
    }) {
      return h(
        'div',
        { style: styles.block },
        h('div', { style: styles.blockTitle }, title),
        h('div', { style: styles.current }, `${t('current')}: ${value}`),
        h(
          'div',
          { style: styles.card },
          h(
            'div',
            { style: styles.list },
            names.map((name) => {
              const picked = name === value
              return h(
                'div',
                {
                  key: name,
                  style: {
                    ...styles.row,
                    background: picked ? 'var(--dsw-alias-bg-layer-2)' : 'transparent',
                  },
                  onClick: () => onPick(name),
                },
                h(
                  'span',
                  {
                    style: {
                      ...styles.dot,
                      color: picked
                        ? 'var(--dsw-alias-brand-primary)'
                        : 'var(--dsw-alias-state-idle-primary)',
                    },
                  },
                  picked ? '●' : '○',
                ),
                h('span', { style: styles.name, title: name }, name),
                h(
                  'button',
                  {
                    type: 'button',
                    style: styles.play,
                    title: t('audition'),
                    onClick: (event) => {
                      event.stopPropagation()
                      onAudition(name)
                    },
                  },
                  '▶',
                ),
              )
            }),
          ),
          h(
            'div',
            { style: styles.footer },
            h('span', { style: styles.hint }, t('customLabel')),
            h('input', {
              type: 'text',
              style: styles.input,
              value: custom,
              placeholder: t('customPlaceholder'),
              spellCheck: false,
              onChange: (event) => onCustomChange(event.target.value),
              onKeyDown: (event) => {
                if (event.key === 'Enter') onCustomUse(custom)
              },
            }),
            h(
              'button',
              {
                type: 'button',
                style: styles.primary,
                onClick: () => onAudition(custom),
              },
              '▶',
            ),
            h(
              'button',
              { type: 'button', style: styles.primary, onClick: () => onCustomUse(custom) },
              t('use'),
            ),
          ),
        ),
      )
    }

    /** The settings page itself. */
    function SettingsPanel({ call, t }) {
      const [data, setData] = useState(null)
      const [custom, setCustom] = useState({ attention: '', done: '' })
      const [status, setStatus] = useState(null)

      const report = useCallback(
        (ok, text) => setStatus({ ok, text }),
        [],
      )

      /**
       * A missing route is the one error worth explaining: a 404/405 from the
       * Host means its registration never ran, which is a different problem
       * from a rejected or failed request.
       */
      const explain = useCallback(
        (error) => {
          const message = String(error?.message ?? error)
          return /HTTP 40[45]/.test(message) ? `${t('hostChannelMissing')} (${message})` : message
        },
        [t],
      )

      const load = useCallback(async () => {
        try {
          const result = await call('get', {})
          if (result?.ok && result.value) {
            setData(result.value)
            report(true, null)
          } else {
            report(false, result?.error?.message ?? t('failed'))
          }
        } catch (error) {
          report(false, `${t('noConnection')} (${explain(error)})`)
        }
      }, [call, report, t, explain])

      useEffect(() => {
        void load()
      }, [load])

      const save = useCallback(
        async (patch) => {
          try {
            const result = await call('set', { patch })
            if (result?.ok && result.value) {
              setData((previous) =>
                previous ? { ...previous, config: result.value.config } : previous,
              )
              report(true, t('saved'))
            } else {
              report(false, explain(result?.error ?? result))
            }
          } catch (error) {
            report(false, explain(error))
          }
        },
        [call, report, t],
      )

      const audition = useCallback(
        async (sound) => {
          const asked = typeof sound === 'string' ? sound.trim() : ''
          if (!asked) return
          try {
            const result = await call('preview', { sound: asked })
            if (!result?.ok) {
              report(false, explain(result?.error ?? result))
              return
            }
            if (result.value?.exists) report(true, null)
            else report(false, `${t('missing')}: ${result.value?.path ?? asked}`)
          } catch (error) {
            report(false, explain(error))
          }
        },
        [call, report, t, explain],
      )

      const pick = useCallback(
        (kind, sound) => {
          setCustom((previous) => ({ ...previous, [kind]: '' }))
          void save({ [kind]: { sound } })
          void audition(sound)
        },
        [audition, save],
      )

      /** Commit a custom path as the chosen sound, then play it. */
      const pickCustom = useCallback(
        (kind, text) => {
          const sound = typeof text === 'string' ? text.trim() : ''
          if (!sound) return
          void save({ [kind]: { sound } })
          void audition(sound)
        },
        [audition, save],
      )

      if (!data) {
        return h(
          'div',
          { style: styles.page },
          h('div', { style: styles.blockTitle }, t('title')),
          status
            ? h('div', { style: status.ok ? styles.statusOk : styles.statusError }, status.text)
            : h('div', { style: styles.hint }, t('loading')),
        )
      }

      const config = data.config ?? {}
      const names = Array.isArray(data.sounds) ? data.sounds : []

      return h(
        'div',
        { style: styles.page },
        h('div', { style: styles.blockTitle }, t('title')),
        h('div', { style: styles.intro }, t('intro')),

        h(Toggle, {
          checked: config.enabled,
          onChange: (value) => void save({ enabled: value }),
          label: t('enabled'),
          hint: t('enabledHint'),
        }),

        h(SoundBlock, {
          t,
          title: t('attention'),
          names,
          value: config.attention?.sound ?? '',
          onPick: (sound) => pick('attention', sound),
          onAudition: (sound) => void audition(sound),
          custom: custom.attention,
          onCustomChange: (text) => setCustom((previous) => ({ ...previous, attention: text })),
          onCustomUse: (text) => pickCustom('attention', text),
        }),

        h(SoundBlock, {
          t,
          title: t('done'),
          names,
          value: config.done?.sound ?? '',
          onPick: (sound) => pick('done', sound),
          onAudition: (sound) => void audition(sound),
          custom: custom.done,
          onCustomChange: (text) => setCustom((previous) => ({ ...previous, done: text })),
          onCustomUse: (text) => pickCustom('done', text),
        }),

        h('div', { style: styles.blockTitle }, t('advanced')),
        h(Toggle, {
          checked: config.muteDelegated,
          onChange: (value) => void save({ muteDelegated: value }),
          label: t('muteDelegated'),
          hint: t('muteDelegatedHint'),
        }),
        h(
          'div',
          { style: styles.toggle },
          h('span', { style: styles.toggleText }, t('minGap')),
          h('input', {
            type: 'number',
            min: 0,
            max: 60000,
            step: 100,
            style: styles.number,
            defaultValue: config.minGapMs,
            key: `gap-${config.minGapMs}`,
            onBlur: (event) => void save({ minGapMs: Number(event.target.value) }),
          }),
        ),
        h(
          'div',
          { style: styles.toggle },
          h('span', { style: styles.toggleText }, t('settle')),
          h('input', {
            type: 'number',
            min: 0,
            max: 60000,
            step: 500,
            style: styles.number,
            defaultValue: config.attentionSettleMs,
            key: `settle-${config.attentionSettleMs}`,
            onBlur: (event) => void save({ attentionSettleMs: Number(event.target.value) }),
          }),
        ),

        status
          ? h(
              'div',
              { style: status.ok ? styles.statusOk : styles.statusError },
              status.text,
            )
          : null,
        h('div', { style: styles.footerNote }, `${names.length} ${t('stockCount')} · ${t('configFile')}: ${data.configPath ?? ''}`),
      )
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), `${NS}: dictionaries`)

      let bind = null
      try {
        bind = ctx.locale.bind(NS)
      } catch {
        bind = null
      }
      const t = makeT(bind)

      /**
       * One call to the Host half.
       *
       * A plain same-origin `fetch` is all that is needed: the `/api` prefix
       * route on the Host applies the Host/Origin fence and the signed browser
       * cookie, so this request is authenticated exactly like the rest of the
       * UI. Every failure comes back as a normal envelope rather than a
       * rejected promise, so the page can always render something.
       */
      const call = async (endpoint, payload) => {
        try {
          const response = await window.fetch(ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ endpoint, payload }),
          })
          if (!response.ok) {
            return {
              ok: false,
              error: {
                code: 'transport',
                message: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`,
                details: {},
              },
            }
          }
          const envelope = await response.json()
          if (envelope && typeof envelope === 'object' && typeof envelope.ok === 'boolean') {
            return envelope
          }
          return {
            ok: false,
            error: { code: 'bad-response', message: t('failed'), details: {} },
          }
        } catch (error) {
          return {
            ok: false,
            error: {
              code: 'transport',
              message: String(error?.message ?? error),
              details: {},
            },
          }
        }
      }

      const Panel = () => h(SettingsPanel, { call, t })

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: NS,
            order: ORDER,
            label: () => t('title'),
          },
          Panel,
        ),
      )

      return undefined
    }

    return { inject, apply }
  },
})
