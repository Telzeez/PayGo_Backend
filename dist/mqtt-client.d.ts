declare class MqttService {
    private client;
    connect(): void;
    private handleMessage;
    private handleEnergyReport;
    private handleRedemption;
    private publishResponse;
    disconnect(): void;
}
declare const mqttService: MqttService;
export default mqttService;
