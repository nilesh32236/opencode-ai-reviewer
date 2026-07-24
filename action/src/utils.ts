export const sanitize = (message: string): string => {
  return message
    .replace(/(Bearer\s+)[a-zA-Z0-9._\-+/]+/gi, '$1***')
    .replace(/(ghp_|gho_|ghu_|ghs_|ghr_)[a-zA-Z0-9_]+/g, '***')
    .replace(/(sk-[a-zA-Z0-9]{20,})/g, 'sk-***')
    .replace(/(xox[bpras]-\d+-)[a-zA-Z0-9-]+/g, '$1***');
};
