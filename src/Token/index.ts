import { Transaction, SystemProgram, Keypair, Connection, PublicKey, sendAndConfirmTransaction } from "@solana/web3.js";
import { MINT_SIZE, TOKEN_PROGRAM_ID, createInitializeMintInstruction, getMinimumBalanceForRentExemptMint, getAssociatedTokenAddress, createAssociatedTokenAccountInstruction, createMintToInstruction } from '@solana/spl-token';
import { DataV2, createCreateMetadataAccountV3Instruction } from '@metaplex-foundation/mpl-token-metadata';
import { bundlrStorage, keypairIdentity, Metaplex, UploadMetadataInput } from '@metaplex-foundation/js';
import { getAdminAccount, getRPCEndpoint, getTokenAccounts } from "../../utils";
import { loadOrGenerateKeypair } from "../Helpers";
import { EXP_TOKEN, EXP_TOKEN_DECIMALS, EXP_TOKEN_SYMBOL, GOLD_TOKEN, GOLD_TOKEN_DECIMALS, GOLD_TOKEN_SYMBOL } from "../Constants";

const endpoint = getRPCEndpoint(); //Replace with your RPC Endpoint
const connection = new Connection(endpoint);

const account = getAdminAccount();
const metaplex = Metaplex.make(connection)
    .use(keypairIdentity(account))
    .use(bundlrStorage({
        address: 'https://devnet.bundlr.network',
        providerUrl: endpoint,
        timeout: 60000,
    }));

/**
 * 
 * @param wallet Solana Keypair
 * @param tokenMetadata Metaplex Fungible Token Standard object 
 * @returns Arweave url for our metadata json file
 */
const uploadMetadata = async (tokenMetadata: UploadMetadataInput): Promise<string> => {
    //Upload to Arweave
    const { uri } = await metaplex.nfts().uploadMetadata(tokenMetadata);
    console.log(`Arweave URL: `, uri);
    return uri;
}

const createNewMintTransaction = async ( whichToken: "gold" | "exp" ) => {
    const payer = getAdminAccount();
    const mintKeypair = loadOrGenerateKeypair(whichToken);
    const decimals = whichToken === "gold"? GOLD_TOKEN_DECIMALS : EXP_TOKEN_DECIMALS;

    //Get the minimum lamport balance to create a new account and avoid rent payments
    const requiredBalance = await getMinimumBalanceForRentExemptMint(connection);
    //metadata account associated with mint
    const metadataPDA = await metaplex.nfts().pdas().metadata({ mint: mintKeypair.publicKey });
    //get associated token account of your wallet

    let MY_TOKEN_METADATA: UploadMetadataInput = {
        name: whichToken === "gold"? GOLD_TOKEN : EXP_TOKEN,
        symbol: whichToken === "gold"? GOLD_TOKEN_SYMBOL : EXP_TOKEN_SYMBOL,
        description: whichToken === "gold"? "Solar Hunt Gold" : "Solar Hunt Experience",
        image: "https://URL_TO_YOUR_IMAGE.png" //add public URL to image you'd like to use, todo
    }

    let ON_CHAIN_METADATA = {
        name: MY_TOKEN_METADATA.name, 
        symbol: MY_TOKEN_METADATA.symbol,
        uri: 'TO_UPDATE_LATER',
        sellerFeeBasisPoints: 0,
        creators: null,
        collection: null,
        uses: null
    } as DataV2;
    
    console.log(`---STEP 1: Uploading MetaData---`);
    let metadataUri = await uploadMetadata(MY_TOKEN_METADATA);
    ON_CHAIN_METADATA.uri = metadataUri;

    console.log(`---STEP 2: Creating Mint Transaction---`);
    const createNewTokenTransaction = new Transaction().add(
        SystemProgram.createAccount({
            fromPubkey: payer.publicKey,
            newAccountPubkey: mintKeypair.publicKey,
            space: MINT_SIZE,
            lamports: requiredBalance,
            programId: TOKEN_PROGRAM_ID,
        }),
        createInitializeMintInstruction(
          mintKeypair.publicKey, //Mint Address
          decimals, //Number of Decimals of New mint
          payer.publicKey, //Mint Authority
          payer.publicKey, //Freeze Authority
          TOKEN_PROGRAM_ID),
        createCreateMetadataAccountV3Instruction({
            metadata: metadataPDA,
            mint: mintKeypair.publicKey,
            mintAuthority: payer.publicKey,
            payer: payer.publicKey,
            updateAuthority: payer.publicKey,
        }, {
            createMetadataAccountArgsV3: {
                data: ON_CHAIN_METADATA,
                isMutable: true,
                collectionDetails: null
            }
        })
    );

    return createNewTokenTransaction;
}


const createNewMintToInstruction = async (destinationWallet: PublicKey, whichToken: "gold" | "exp", amount: number)=>{
    const mintKeypair = loadOrGenerateKeypair(whichToken);
    const decimals = whichToken === "gold"? GOLD_TOKEN_DECIMALS : EXP_TOKEN_DECIMALS;
    
    // console.log(`---STEP 1: Get Associated Address---`);
    //get associated token account of your wallet
    const tokenATA = await getAssociatedTokenAddress(mintKeypair.publicKey, destinationWallet);
    const mintObject = await getUserTokens(destinationWallet);
    let shouldCreateNewATA = !Object.keys(mintObject).includes(mintKeypair.publicKey.toBase58()); 
    
    // console.log({ shouldCreateNewATA });
    // console.log(tokenATA.toBase58());

    const mintNewTokenInstruction = new Transaction();
    if(shouldCreateNewATA) {
        mintNewTokenInstruction.add(
            createAssociatedTokenAccountInstruction(
              account.publicKey, //Payer 
              tokenATA, //Associated token account 
              destinationWallet, //token owner
              mintKeypair.publicKey, //Mint
            ),
        );
    }
    mintNewTokenInstruction.add(
        createMintToInstruction(
          mintKeypair.publicKey, //Mint
          tokenATA, //Destination Token Account
          account.publicKey, //Authority
          amount * Math.pow(10, decimals),//number of tokens
        ),
    );

    return mintNewTokenInstruction;
}

export const initializeToken = async(whichToken: "gold" | "exp") => {
    const newMintTransaction:Transaction = await createNewMintTransaction(whichToken);
    const mintKeypair = loadOrGenerateKeypair(whichToken);

    console.log(`---STEP 3: Executing Mint Transaction---`);
    let { lastValidBlockHeight, blockhash } = await connection.getLatestBlockhash('finalized');
    newMintTransaction.recentBlockhash = blockhash;
    newMintTransaction.lastValidBlockHeight = lastValidBlockHeight;
    newMintTransaction.feePayer = account.publicKey;
    const transactionId = await sendAndConfirmTransaction(connection,newMintTransaction,[account,mintKeypair]); 
    // console.log(`Transaction ID: `, transactionId);
    // console.log(`View Transaction: https://explorer.solana.com/tx/${transactionId}?cluster=devnet`);
    // console.log(`View Token Mint: https://explorer.solana.com/address/${mintKeypair.publicKey.toString()}?cluster=devnet`)
}

export const getTokenPublicKey = (whichToken: "gold" | "exp") => {
    return loadOrGenerateKeypair(whichToken).publicKey.toBase58();
}

export const getUserTokens = async(destinationWallet: PublicKey) => {
    let mintObject: {[mintAddress: string]: number} = {};
    let userAccounts = await getTokenAccounts(connection, destinationWallet.toString());
    for(let account of userAccounts) {
      let anyAccount = account.account as any;
      let mint: string = anyAccount.data["parsed"]["info"]["mint"];
      let accountAmount: number = anyAccount.data["parsed"]["info"]["tokenAmount"]["uiAmount"];

      mintObject[mint] = accountAmount;
    }

    return mintObject;
}

export const mintTo = async(destinationWallet: PublicKey, whichToken: "gold" | "exp", amount: number) => {
    const newMintTransaction:Transaction = await createNewMintToInstruction(destinationWallet, whichToken, amount);
    // const mintKeypair = loadOrGenerateKeypair(whichToken);

    // console.log(`---STEP 2: Executing Mint Transaction---`);
    let { lastValidBlockHeight, blockhash } = await connection.getLatestBlockhash('finalized');
    newMintTransaction.recentBlockhash = blockhash;
    newMintTransaction.lastValidBlockHeight = lastValidBlockHeight;
    newMintTransaction.feePayer = account.publicKey;
    const transactionId = await sendAndConfirmTransaction(connection,newMintTransaction,[account]); 
    console.log(`Completed Mint: ${amount} ` + whichToken);
    // console.log(`Transaction ID: `, transactionId);
    // console.log(`View Transaction: https://explorer.solana.com/tx/${transactionId}?cluster=devnet`);
    // console.log(`View Token Mint: https://explorer.solana.com/address/${mintKeypair.publicKey.toString()}?cluster=devnet`)
}