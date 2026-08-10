import axios from 'axios';
import dotenv from 'dotenv';
dotenv.config();


export async function sendSms(phoneNumber:string, tokenCode:string): Promise<void> {
    try {
        const apiKey: string = process.env.SMS_API_KEY || '';
        if(!apiKey){
              console.log(`📱 [DEV] Token for ${phoneNumber}: ${tokenCode}`);
      console.warn('SMS not sent - SMS_API_KEY not configured');
      return;
        }
        const response = await axios.post(process.env.BASE_URL || '', {
            to: phoneNumber,
            from: "PAYGO",
            sms: `Your PAYGO token is ${tokenCode}. valid for 72 hours.`,
            type: 'plain',
            channel: 'generic',
            api_key: apiKey,
        }, {
            timeout: 10000,
            headers: {'Content-Type': 'application/json'}
        }
    
    );
    console.log(`📨 SMS sent to ${phoneNumber}: ${tokenCode}`);
    
    } catch (error) {
         console.log(`📱 [FALLBACK] Token for ${phoneNumber}: ${tokenCode}`);
    console.warn('SMS sending failed:', error);
    }
}