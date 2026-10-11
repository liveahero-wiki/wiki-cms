import type { Lang } from '../../../src/shared/i18n.ts'

// Strings for the tiny loader only (kept out of the main bundles so v1.js stays small).
export const loaderStrings: Record<Lang, { loading: string; failed: string; retry: string }> = {
  en: { loading: 'Loading community team formations…', failed: 'Could not load the community team formations.', retry: 'Try again' },
  'zh-Hans': { loading: '正在加载社区队伍配置…', failed: '无法加载社区队伍配置。', retry: '重试' },
  'zh-Hant': { loading: '正在載入社群隊伍配置…', failed: '無法載入社群隊伍配置。', retry: '重試' },
  ja: { loading: 'コミュニティの編成を読み込み中…', failed: 'コミュニティの編成を読み込めませんでした。', retry: '再試行' },
}
