import { AbstractPaymentProvider, MedusaError } from "@medusajs/framework/utils";
import { z } from "zod";
import { Currency, Order, PayU, Buyer, Product } from "@ingameltd/payu";
import { Logger } from "@medusajs/medusa";
import { AuthorizePaymentInput, AuthorizePaymentOutput, CancelPaymentInput, CancelPaymentOutput, CapturePaymentInput, CapturePaymentOutput, DeletePaymentInput, DeletePaymentOutput, GetPaymentStatusInput, GetPaymentStatusOutput, InitiatePaymentInput, InitiatePaymentOutput, ProviderWebhookPayload, RefundPaymentInput, RefundPaymentOutput, RetrievePaymentInput, RetrievePaymentOutput, UpdatePaymentInput, UpdatePaymentOutput, WebhookActionResult } from "@medusajs/types";

export type PayUNotification = {
    order: {
        orderId: string;
        extOrderId: string;
        orderCreateDate: string;
        notifyUrl: string;
        customerIp: string;
        merchantPosId: string;
        description: string;
        currencyCode: string;
        totalAmount: string;
        buyer: Buyer;
        payMethod: string;
        products: Product[];
        status: string;
    };
    localReceiptDateTime: string;
    properties: Array<{
        name: string;
        value: string;
    }>;
};

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
    method: "gateway";
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

        if (!SupportedCurrencies.includes(input.currency_code)) {
            throw new MedusaError(
                MedusaError.Types.INVALID_ARGUMENT,
                `Currency ${input.currency_code} is not supported by PayU`
            );
        }

        const parsedInput = InitiatePaymentSchema.parse(input.data);

        const order: Order = {
            description: this.options_.title || `Płatność za zamówienie #${sessionId}`,
            currencyCode: input.currency_code as unknown as Currency,
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

        const result = await this.client_.createOrder(order).catch(() => {
            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                "Failed to create PayU order"
            );
        })
        const paymentData: PayUPaymentData = {
            session_id: sessionId,
            order_id: result.orderId,
            amount: order.totalAmount,
            method: "gateway",
            currency: order.currencyCode,
            url: result.redirectUri,
        };

        return {
            id: sessionId,
            data: { ...paymentData },
            status: "requires_more"
        }
    }

    async getWebhookActionAndData(payload: ProviderWebhookPayload["payload"]): Promise<WebhookActionResult> {
        const { data, headers, rawData } = payload;

        const signatureHeader = headers['OpenPayu-Signature'];
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

        const notification = data as PayUNotification;

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
                action: "failed",
                data: {
                    amount: Number(notification.order.totalAmount) / 100,
                    session_id: notification.order.extOrderId
                }
            }
        }

        throw new MedusaError(
            MedusaError.Types.UNEXPECTED_STATE,
            `Unhandled PayU order status: ${notification.order.status}`
        );


    }

    async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
        return {
            status: "pending",
            data: { ...input.data }
        };
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
            this.logger_.error(`Failed to capture PayU order with ID: ${orderId}`);
            this.logger_.error(JSON.stringify(e));

            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                "Failed to capture PayU order"
            );
        });

        if (captureResult.status.statusCode !== "SUCCESS") {
            this.logger_.error(`Failed to capture PayU order with ID: ${orderId}, status: ${captureResult.status.statusCode}`);
            this.logger_.error(JSON.stringify(captureResult));

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
            this.logger_.error(`Failed to refund PayU order with ID: ${orderId}`);
            this.logger_.error(JSON.stringify(e))

            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                "Failed to refund PayU order"
            );
        });

        if (refundResult.status.statusCode !== "SUCCESS") {
            this.logger_.error(`Failed to refund PayU order with ID: ${orderId}, status: ${refundResult.status.statusCode}`);
            this.logger_.error(JSON.stringify(refundResult));

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
            this.logger_.error(`Failed to cancel PayU order with ID: ${orderId}`);
            this.logger_.error(JSON.stringify(e));

            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                "Failed to cancel PayU order"
            );
        });

        if (cancelResult.status.statusCode !== "SUCCESS") {
            this.logger_.error(`Failed to cancel PayU order with ID: ${orderId}, status: ${cancelResult.status.statusCode}`);
            this.logger_.error(JSON.stringify(cancelResult));

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
        return { status: "pending" };
    }

    async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
        return { data: { ...input.data } };
    }
}