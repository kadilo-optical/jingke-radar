/* 云端服务公开配置（可安全置于前端：不含任何长期密钥） */
window.PUBLIC_CONFIG = {
  resourceId: "wbcs_njFclweNRa0jRF0QI6sjbj",
  endpoint: "https://glasses-radar.app.workbuddy.host",
  oauthRelayBaseUrl: "https://www.workbuddy.cn/v2/as/genie-baas/oauth",
  publishableKey: "wbpk_I27VHHAlXoibDl52aAwgZm_Hjo4D2MwmnxqqtaLVoId9dIwlf1H1MS1"
};

/* 运行环境标记：同一份页面既跑在网页域名下，也跑在 Android 外壳里（origin 为 https://localhost） */
window.APP_ENV = (/^https?:\/\/localhost(:\d+)?$/.test(location.origin) || location.protocol === 'file:')
  ? 'native'
  : 'web';
