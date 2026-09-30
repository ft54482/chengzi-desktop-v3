/** Client-facing view types for the local Chengzi Account web-server routes. */

/** Provisioning lifecycle reported by the account service. */
export type ChengziProvisionStateView = 'none' | 'pending' | 'ready' | 'failed'

/** Account identity exposed to the Client; never a token.
 *  `phone` 可空：账号密码登录的官网用户可能没有手机号（显示层回退 nickname）。 */
export interface ChengziAccountUserView {
  readonly id: string
  readonly phone: string | null
  readonly nickname: string | null
}

/** 余额视图：tokens=平台 quota；cny=人民币元（官网口径，设置页展示用）。 */
export interface ChengziAccountBalanceView {
  readonly tokens: number
  readonly cny?: number
}

/** Response of `GET /plugins/chengzi-account/me`. */
export interface ChengziAccountMeResponse {
  readonly authenticated: boolean
  readonly user?: ChengziAccountUserView
  readonly balance?: ChengziAccountBalanceView
}

/** Response of `POST /plugins/chengzi-account/login`. */
export interface ChengziAccountLoginResponse {
  readonly user: ChengziAccountUserView
  readonly balance: ChengziAccountBalanceView
  readonly provisionState: ChengziProvisionStateView
}

/** Response of `GET /plugins/chengzi-account/api-key` on success. */
export interface ChengziAccountApiKeyView {
  readonly apiKey: string
  readonly baseUrl: string
  readonly group: string
}

/** One recharge package; `tokens` already includes `bonusTokens`. */
export interface ChengziPackageView {
  readonly id: string
  readonly name: string
  readonly priceCents: number
  readonly tokens: number
  readonly bonusTokens: number
}

/** Response of `GET /plugins/chengzi-account/packages`. */
export interface ChengziPackagesResponse {
  readonly packages: readonly ChengziPackageView[]
}

/** Response of `POST /plugins/chengzi-account/orders`; `stub` marks the sandbox demo code. */
export interface ChengziOrderCreationResponse {
  readonly orderNo: string
  readonly amountCents: number
  readonly qrCode: string
  readonly stub?: true
}

/** Order lifecycle; `paid` means payment was received. */
export type ChengziOrderStatusView = 'pending' | 'paid'

/** Response of `GET /plugins/chengzi-account/order?orderNo=...`. */
export interface ChengziOrderStatusResponse {
  readonly orderNo: string
  readonly status: ChengziOrderStatusView
  readonly amountCents: number
  readonly tokens: number
  readonly createdAt: string
  readonly paidAt: string | null
}
