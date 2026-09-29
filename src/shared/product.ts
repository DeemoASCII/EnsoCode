/** 由构建器固定，打包后的身份不能通过运行时环境变量切换。 */
declare const __ENSO_PRODUCT__: string | undefined;

export function productFor(value: string | undefined) {
  if (value === 'ensobot')
    return { name: 'EnsoBot', slug: 'ensobot', appId: 'com.j3n5en.ensobot' } as const;
  if (value !== undefined && value !== 'ensocode') throw new Error(`Unknown product: ${value}`);
  return { name: 'EnsoCode', slug: 'enso-code', appId: 'com.j3n5en.enso-code' } as const;
}

export function userDataDirectory(value: string | undefined, packaged: boolean): string {
  return `${productFor(value).slug}${packaged ? '' : '-dev'}`;
}

export const PRODUCT = productFor(
  typeof __ENSO_PRODUCT__ === 'undefined' ? undefined : __ENSO_PRODUCT__
);
