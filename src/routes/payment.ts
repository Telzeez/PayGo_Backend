import { PaymentInitialRequest } from './../types/index';
import express, {Request, Response} from 'express'
import axios from 'axios';
import { PaymentInitialRequest } from '../types/index';
import dotenv from 'dotenv'
import Request from 'express';

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
    } catch (error) {
        
    }
})






const paymentRoutes = () => {
    return res.status(201).json({res: "webhooroutes"})
}
export default paymentRoutes