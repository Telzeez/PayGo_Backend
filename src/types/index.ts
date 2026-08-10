export interface PaygoToken {
    id: number;
    buyerEmail: string;
    deviceId: string;
    kwhAmount: number;
    tokenHash: string;
    createdAt: Date;
    expiresAt: Date;
    used: boolean;
    redeemedAt: Date | null;

}
export interface Device {
    id: number;
    deviceId: string;
    currentBalance: number;
    lastUpdated: Date;
}

export interface Transaction {
    id: number;
    deviceId: string;
    type: 'topup'| 'consumption';
    amount: number;
    timestamp: Date;

}
export interface PaymentInitialRequest {
    amount: number;
    email: string
    deviceId: string;
}
export interface MqttRedeemPayload{
    code: string;
}
export interface MqttCreditCommand {
    action: 'CREDIT';
    kwh: number;
    timestamp: Date;
}

export interface MqttResponsePayload {
    status: 'SUCCESS'| 'ERROR';
    message: string;
    timestamp: string;
}
export interface PaystackWebhookEvent {
    event: 'charge.success' | 'charge.failed';
    data: {
        amount: number;
        customer: {email: string};
        metadata: {deviceid?: string};
        reference: string
    }
}