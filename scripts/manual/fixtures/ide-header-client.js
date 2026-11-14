// Test-only extension pressure: use the real host header slots to catch layout
// regressions introduced by multiple agent/tool plugins. Never shipped in tgz.
window.__ModuleLoader__.load({
  id: 'ide-header-fixture',
  factory: require => {
    const React = require('react')
    const control = (id, label, title) => React.createElement('button', {
      key: id, type: 'button', title, 'aria-label': title,
      'data-ide-e2e-header-control': id,
      style: { flexShrink: 0, height: 26, padding: '2px 7px', border: '1px solid var(--dsw-alias-border-l2,#ddd)', borderRadius: 5, background: 'var(--dsw-alias-bg-base,#fff)', color: 'inherit', fontSize: 12, display: 'inline-flex', alignItems: 'center' },
    }, label)
    function AgentButtons() { return React.createElement(React.Fragment, null, control('agent-one', 'Agent', 'Agent fixture one'), control('agent-two', 'Agent', 'Agent fixture two')) }
    function ToolButtons() { return React.createElement(React.Fragment, null, control('refresh', '↻', 'Fixture refresh'), control('inspect', '↗', 'Fixture inspect'), control('more', '⋯', 'Fixture more')) }
    return {
      name: 'ide-header-fixture', inject: ['slots'],
      apply(ctx) {
        const slots = ctx.get('slots')
        slots.inject('conversation.session.header.actions', () => slots.register({ name: 'conversation.session.header.actions', id: 'ide-e2e-agent-actions', order: -5 }, AgentButtons))
        slots.inject('conversation.session.header.utilities', () => slots.register({ name: 'conversation.session.header.utilities', id: 'ide-e2e-toolbar', order: 25 }, ToolButtons))
        ctx.inject(['sidebarRight'], inner => {
          const controller = inner.get('sidebarRight')
          window.__DSH_IDE_E2E__ = {
            snapshot(sessionId) { return { active: controller.active(), tabs: controller.tabsIn(sessionId), expanded: controller.isExpanded(), mounted: controller.mounted.getSnapshot() } },
            closeDocuments(sessionId) {
              // Native domain close intent, scoped to exactly the fixture Session.
              for (const tab of [...controller.tabsIn(sessionId)]) if (tab.kind !== 'guide') controller.closeIn(sessionId, tab.id)
            },
          }
          inner.effect(() => () => { delete window.__DSH_IDE_E2E__ }, 'ide-e2e-close-controls')
        })
      },
    }
  },
})
