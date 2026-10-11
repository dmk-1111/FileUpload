// const { MongoClient } = require('mongodb');
// or as an es module:
import { MongoClient } from 'mongodb'
import 'dotenv/config'

// Connection URL
const url = process.env.MONGODB_URL;
export const client = new MongoClient(url);

const currentDateTime = new Date();
export const checkConnection = async () => {
     if(client){
        await client.connect();
        console.log("======== Successful connected to server! ✅");
        console.log(currentDateTime.toString());
    }else{
        console.log("======== Failed connect to server! ✖️");
    }
}