export interface User {
    id: number;
    email: string;
    phone?: string;
    role: string;
    isBuyer: boolean;
    isSeller: boolean;
    createdAt: Date;
}

export interface RegisterRequest {
    email: string;
    password: string;
    phone?: string;
    role?: string;
    isBuyer?: boolean;
    isSeller?: boolean;
}

export interface LoginRequest {
    email: string;
    password: string;
}

export interface AuthResponse {
    success: boolean;
    token: string;
    user: {
        id: number;
        email: string;
        phone?: string;
        role: string;
        isBuyer: boolean;
        isSeller: boolean;
    };
}

export interface JwtPayload {
    userId: number;
    email: string;
    role: string;
    isBuyer: boolean;
    isSeller: boolean;
}

export interface Device {
    id: number;
    deviceId: string;
    currentBalance: number;
    status?: 'ONLINE' | 'OFFLINE';
    lastSeenAt?: Date | null;
    lastUpdated: Date;
}

export interface Transaction {
    id: number;
    deviceId: string;
    type: 'topup' | 'consumption';
    amount: number;       // Monetary amount in Naira
    kwhAmount: number;    // Energy amount in kWh
    transactionId?: string;
    reference?: string;
    hardwareStatus?: 'PENDING' | 'CONFIRMED' | 'FAILED';
    retryCount?: number;
    lastAttemptAt?: Date | null;
    timestamp: Date;
}
export interface PaymentInitialRequest {
    amount: number;
    email: string;
    deviceId: string;
    marketplacePurchaseId?: number;
}
export interface MqttCreditCommand {
    action: 'CREDIT';
    transactionId: string;
    deviceId: string;
    kwh: number;
    timestamp: string;
}

export interface MqttCreditAck {
    action: 'CREDIT_ACK';
    transactionId: string;
    deviceId: string;
    status: 'ACCEPTED' | 'REJECTED';
    reason?: string;
    balance?: number;
    timestamp: string;
}

export interface PaystackWebhookEvent {
    event: 'charge.success' | 'charge.failed';
    data: {
        amount: number;
        customer: {email: string};
        metadata: {deviceId?: string; deviceid?: string; marketplacePurchaseId?: number | string};
        reference: string
    }
}