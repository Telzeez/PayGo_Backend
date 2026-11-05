import express, { Request, Response } from 'express';
import axios from 'axios';
import { PaymentInitialRequest } from '../types/index.js';
import dotenv from 'dotenv';

dotenv.config()

const router = express.Router();

router.post('/initiate', async (req:Request, res:Response) => {
    try {
        const {amount, email, deviceId} = req.body as PaymentInitialRequest;

        if(!amount || !email || !deviceId){
            return res.status(400).json({
                success: false,
                error: `Missing required field: amount entered ${!amount? "null" : amount} email: ${!email? "null": email}, deviceId: ${!deviceId? "null" : deviceId}`
            })
        }
        if(amount < 100){
            return res.status(400).json({
                success: false,
                error: "Minimum payment is #100"
            })
        }

        // Determine frontend URL (env var, or dynamic request origin from browser, or localhost fallback)
        const requestOrigin = (req.headers.origin as string) || (req.headers.referer ? new URL(req.headers.referer).origin : undefined);
        const FRONTEND_URL = (process.env.FRONTEND_URL || requestOrigin || 'http://localhost:3000').replace(/\/+$/, '');
        const response = await axios.post(
            'https://api.paystack.co/transaction/initialize',
            {
                email,
                amount: amount* 100,
                metadata: {deviceId},
                callback_url: `${FRONTEND_URL}/verify`
            },
            {
                headers:{
                    Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
                    'Content-Type': 'application/json'
                },
                timeout: 10000
            }
        )

    if(!response.data.status){
        return res.status(400).json({
            success: false,

            error: 'Paystack initialization failed'
        })
    }
    res.json({
        success: true,
        paymentUrl: response.data.data.authorization_url,
        reference: response.data.data.reference,
    })

    } catch (error) {
        console.error('Payment iniitation error ', error);
        res.status(500).json({
            success: false,
            error: 'Payment initiation failed'
        })
    }
    
})

export default router