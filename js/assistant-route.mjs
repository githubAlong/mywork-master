/* 小助手路由归一化（2026-11-25）
   6 个学生端互动工具收进一级导航「小助手」后，统一使用 #/materials/<tab>。
   单独成模块有两个原因：ui.js 和 main.js 共用同一份清单，不会各写一份漏一个；
   纯函数没有 DOM 依赖，可以直接单测「旧地址到底跳到哪」。 */
export const ASSISTANT_ROOT = 'materials';
export const ASSISTANT_DEFAULT = 'selfstudy';
export const ASSISTANT_TABS = Object.freeze([
  'selfstudy', 'textbook', 'pick', 'mystery', 'misconduct', 'bulletin',
]);

/* 返回归一化后的路径；不需要跳转时原样返回。
   · #/textbook、#/selfstudy …（旧平级地址）→ #/materials/<tab>
   · #/work/materials/textbook、#/work/pick …（更老的地址）→ #/materials/<tab>
   · #/materials 保持原样：它仍是老课件总览页，收藏夹链接不能失效
   · #/materials/textbook 保持原样：已经是新地址 */
export function normalizeAssistantRoute(path) {
  const [seg, tab, third] = String(path || '').split('/');
  if (ASSISTANT_TABS.includes(seg)) {
    return `${ASSISTANT_ROOT}/${[seg, tab, third].filter(Boolean).join('/')}`;
  }
  if (seg === 'work' && (tab === ASSISTANT_ROOT || ASSISTANT_TABS.includes(tab))) {
    const rest = tab === ASSISTANT_ROOT ? (third || '') : [tab, third].filter(Boolean).join('/');
    return `${ASSISTANT_ROOT}/${rest || ASSISTANT_DEFAULT}`;
  }
  return path;
}
