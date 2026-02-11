import { AbstractPaymentProvider, MedusaError, ModuleProvider, Modules } from "@medusajs/framework/utils";
import { z } from "zod";
import { Currency, Order, PayU, Buyer, Product, OrderNotification } from "@tax1driver/ts-payu";
import { Logger } from "@medusajs/medusa";
import { AuthorizePaymentInput, AuthorizePaymentOutput, CancelPaymentInput, CancelPaymentOutput, CapturePaymentInput, CapturePaymentOutput, DeletePaymentInput, DeletePaymentOutput, GetPaymentStatusInput, GetPaymentStatusOutput, InitiatePaymentInput, InitiatePaymentOutput, ProviderWebhookPayload, RefundPaymentInput, RefundPaymentOutput, RetrievePaymentInput, RetrievePaymentOutput, UpdatePaymentInput, UpdatePaymentOutput, WebhookActionResult } from "@medusajs/types";


export const PayUOptionsSchema = z.object({
    clientId: z.coerce.number(),
    clientSecret: z.string(),
    merchantPosId: z.coerce.number(),
    secondKey: z.coerce.string(),
    sandbox: z.boolean().optional().default(true),
    returnUrl: z.string().url(),
    callbackUrl: z.string().url(),
    title: z.string().optional(),
    refundDescription: z.string().optional(),
});

export const InitiatePaymentSchema = z.object({
    session_id: z.string(),
    email: z.string().email(),
    customer_ip: z.string(),
});

export type PayUOptions = z.infer<typeof PayUOptionsSchema>;


interface PayUPaymentData {
    session_id: string;
    order_id: string;
    amount: number;
    currency: string;
    url: string;
}


const SupportedCurrencies = ["PLN", "EUR", "USD", "GBP"];

type InjectedDeps = {
    logger: Logger;
}


export class PayUPaymentProviderService extends AbstractPaymentProvider<PayUOptions> {
    static identifier = "payu";

    protected logger_: Logger;
    protected options_: PayUOptions;
    protected client_: PayU;

    constructor(
        container: InjectedDeps,
        options: PayUOptions
    ) {
        super(container, options);
        this.logger_ = container.logger;

        this.options_ = PayUOptionsSchema.parse(options);

        this.client_ = new PayU(
            this.options_.clientId,
            this.options_.clientSecret,
            this.options_.merchantPosId,
            this.options_.secondKey,
            { sandbox: this.options_.sandbox },
        );
    }

    static validateOptions(options: Record<any, any>): void {
        PayUOptionsSchema.parse(options);
    }

    async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
        const sessionId = input.data?.session_id as string;

        if (!sessionId) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                "Session ID is required to initiate PayU payment"
            );
        }

        if (!SupportedCurrencies.includes(input.currency_code.toUpperCase())) {
            throw new MedusaError(
                MedusaError.Types.INVALID_ARGUMENT,
                `Currency ${input.currency_code} is not supported by PayU`
            );
        }

        const parsedInput = InitiatePaymentSchema.parse(input.data);

        const order: Order = {
            description: this.options_.title || `Płatność za zamówienie #${sessionId}`,
            currencyCode: input.currency_code.toUpperCase() as unknown as Currency,
            totalAmount: Math.ceil(Number(input.amount) * 100),
            customerIp: parsedInput.customer_ip,
            buyer: {
                email: parsedInput.email,
            },
            notifyUrl: this.options_.callbackUrl,
            continueUrl: this.options_.returnUrl,
            extOrderId: sessionId,
            products: []
        };

        const result = await this.client_.createOrder(order);

        const paymentData: PayUPaymentData = {
            session_id: sessionId,
            order_id: result.orderId,
            amount: order.totalAmount,
            currency: order.currencyCode,
            url: result.redirectUri,
        };

        return {
            id: sessionId,
            data: { ...paymentData },
            status: "pending"
        }
    }

    async getWebhookActionAndData(payload: ProviderWebhookPayload["payload"]): Promise<WebhookActionResult> {
        const { data, headers, rawData } = payload;

        const signatureHeader = Object.entries(headers).find(([key, _]) => key.toLowerCase() === "openpayu-signature" || key.toLowerCase() === "x-openpayu-signature")?.[1];
        if (!signatureHeader || typeof signatureHeader !== 'string') {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                "Missing or invalid OpenPayu-Signature header"
            );
        }

        const validated = this.client_.verifyNotification(signatureHeader, String(rawData));
        if (!validated) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                "Invalid PayU webhook call"
            );
        }

        const notification = data as unknown as OrderNotification;

        if (!notification.order.extOrderId) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                "Missing extOrderId in PayU webhook payload"
            );
        }

        if (notification.order.status === "COMPLETED") {
            return {
                action: "authorized",
                data: {
                    amount: Number(notification.order.totalAmount) / 100,
                    session_id: notification.order.extOrderId
                }
            }
        } else if (notification.order.status === "CANCELED") {
            return {
                action: "canceled",
                data: {
                    amount: Number(notification.order.totalAmount) / 100,
                    session_id: notification.order.extOrderId
                }
            }
        } else {
            return {
                action: "pending",
                data: {
                    amount: Number(notification.order.totalAmount) / 100,
                    session_id: notification.order.extOrderId
                }
            }
        }


    }

    async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
        const data = input.data as unknown as PayUPaymentData;

        if (!data || !data.order_id) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                "Order ID is required to authorize PayU payment"
            );
        }

        const result = await this.client_
            .getOrder(data.order_id)
            .catch((e) => {
                throw new MedusaError(
                    MedusaError.Types.UNEXPECTED_STATE,
                    "Failed to retrieve PayU order"
                );
            });

        const order = result.orders && result.orders![0] || null;

        if (!order) {
            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                `PayU order with ID ${data.order_id} not found`
            );
        }

        if (order.status !== "COMPLETED") {
            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                `PayU order with ID ${data.order_id} is not completed`
            );
        }

        return { data: { ...input.data }, status: "authorized" };
    }

    async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
        const orderId = input.data?.order_id as string;

        if (!orderId) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                "Session ID is required to capture PayU payment"
            );
        }

        const captureResult = await this.client_.captureOrder(orderId).catch((e) => {
            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                "Failed to capture PayU order"
            );
        });

        if (captureResult.status.statusCode !== "SUCCESS") {
            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                `Failed to capture PayU order with status: ${captureResult.status.statusCode}`
            );
        }

        return { data: { ...input.data } };
    }

    async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
        const orderId = input.data?.order_id as string;

        if (!orderId) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                "Order ID is required to refund PayU payment"
            );
        }

        const refundResult = await this.client_.refundOrder(orderId, this.options_.refundDescription || "Refund").catch((e) => {
            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                "Failed to refund PayU order"
            );
        });

        if (refundResult.status.statusCode !== "SUCCESS") {
            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                `Failed to refund PayU order with status: ${refundResult.status.statusCode}`
            );
        }

        return { data: { ...input.data } };
    }

    async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
        const orderId = input.data?.order_id as string;

        if (!orderId) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                "Order ID is required to cancel PayU payment"
            );
        }

        const cancelResult = await this.client_.cancelOrder(orderId).catch((e) => {
            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                "Failed to cancel PayU order"
            );
        });

        if (cancelResult.status.statusCode !== "SUCCESS") {
            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                `Failed to cancel PayU order with status: ${cancelResult.status.statusCode}`
            );
        }

        return { data: { ...input.data } };
    }

    async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
        return { data: { ...input.data } };
    }

    async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
        return { data: { ...input.data } };
    }

    async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
        const data = input.data as unknown as PayUPaymentData;

        if (!data || !data.order_id) {
            throw new MedusaError(
                MedusaError.Types.INVALID_DATA,
                "Order ID is required to authorize PayU payment"
            );
        }

        const result = await this.client_
            .getOrder(data.order_id)
            .catch((e) => {
                throw new MedusaError(
                    MedusaError.Types.UNEXPECTED_STATE,
                    "Failed to retrieve PayU order"
                );
            });

        const order = result.orders && result.orders![0] || null;

        if (!order) {
            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                `PayU order with ID ${data.order_id} not found`
            );
        }

        if (order.status === "COMPLETED") {
            return { status: "authorized", data: { ...input.data } };
        } else if (order.status === "CANCELED") {
            return { status: "canceled", data: { ...input.data } };
        } else {
            return { status: "pending", data: { ...input.data } };
        }
    }

    async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
        return { data: { ...input.data } };
    }

    getIdentifier(): string {
        return PayUPaymentProviderService.identifier;
    }
}

export default ModuleProvider(Modules.PAYMENT, {
    services: [PayUPaymentProviderService],
});