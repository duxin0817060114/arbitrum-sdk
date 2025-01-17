/*
 * Copyright 2021, Offchain Labs, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/* eslint-env node */
'use strict'

import { defaultAbiCoder } from '@ethersproject/abi'
import { Signer } from '@ethersproject/abstract-signer'
import { Provider, BlockTag } from '@ethersproject/abstract-provider'
import { PayableOverrides, Overrides } from '@ethersproject/contracts'
import { Zero, MaxUint256 } from '@ethersproject/constants'
import { ErrorCode, Logger } from '@ethersproject/logger'
import { BigNumber, ethers } from 'ethers'

import { L1GatewayRouter__factory } from '../abi/factories/L1GatewayRouter__factory'
import { L2GatewayRouter__factory } from '../abi/factories/L2GatewayRouter__factory'
import { L1ERC20Gateway__factory } from '../abi/factories/L1ERC20Gateway__factory'
import { L1WethGateway__factory } from '../abi/factories/L1WethGateway__factory'
import { L2ArbitrumGateway__factory } from '../abi/factories/L2ArbitrumGateway__factory'
import { ERC20__factory } from '../abi/factories/ERC20__factory'
import { ERC20 } from '../abi/ERC20'
import { L2GatewayToken__factory } from '../abi/factories/L2GatewayToken__factory'
import { L2GatewayToken } from '../abi/L2GatewayToken'
import { ICustomToken__factory } from '../abi/factories/ICustomToken__factory'
import { IArbToken__factory } from '../abi/factories/IArbToken__factory'
import { L2CustomGateway__factory } from '../abi/factories/L2CustomGateway__factory'

import { WithdrawalInitiatedEvent } from '../abi/L2ArbitrumGateway'
import { GatewaySetEvent } from '../abi/L1GatewayRouter'
import {
  GasOverrides,
  L1ToL2MessageGasEstimator,
} from '../message/L1ToL2MessageGasEstimator'
import { SignerProviderUtils } from '../dataEntities/signerOrProvider'
import { L2Network } from '../dataEntities/networks'
import { ArbTsError, MissingProviderArbTsError } from '../dataEntities/errors'
import { DISABLED_GATEWAY } from '../dataEntities/constants'

import { EventFetcher } from '../utils/eventFetcher'

import { EthDepositBase, EthWithdrawParams } from './ethBridger'
import { AssetBridger } from './assetBridger'
import {
  L1ContractCallTransaction,
  L1ContractTransaction,
  L1TransactionReceipt,
} from '../message/L1Transaction'
import {
  L2ContractTransaction,
  L2TransactionReceipt,
} from '../message/L2Transaction'

export interface TokenApproveParams {
  /**
   * L1 signer whose tokens are being approved
   */
  l1Signer: Signer

  /**
   * L1 address of the ERC20 token contract
   */
  erc20L1Address: string

  /**
   * Amount to approve. Defaults to max int.
   */
  amount?: BigNumber

  /**
   * Transaction overrides
   */
  overrides?: PayableOverrides
}

export interface TokenDepositParams extends EthDepositBase {
  /**
   * L1 address of the token ERC20 contract
   */
  erc20L1Address: string

  /**
   * L2 address of the entity receiving the funds. Defaults to the l1FromAddress
   */
  destinationAddress?: string

  /**
   * Overrides for the retryable ticket parameters
   */
  retryableGasOverrides?: Omit<GasOverrides, 'sendL2CallValueFromL1'>

  /**
   * Transaction overrides
   */
  overrides?: Overrides
}

export interface TokenWithdrawParams extends EthWithdrawParams {
  /**
   * L1 address of the token ERC20 contract
   */
  erc20l1Address: string
}

/**
 * Bridger for moving ERC20 tokens back and forth betwen L1 to L2
 */
export class Erc20Bridger extends AssetBridger<
  TokenDepositParams,
  TokenWithdrawParams
> {
  public static MAX_APPROVAL = MaxUint256
  public static MIN_CUSTOM_DEPOSIT_MAXGAS = BigNumber.from(275000)

  /**
   * Bridger for moving ERC20 tokens back and forth betwen L1 to L2
   */
  public constructor(l2Network: L2Network) {
    super(l2Network)
  }

  /**
   * Get the address of the l1 gateway for this token
   * @param erc20L1Address
   * @param l1Provider
   * @returns
   */
  public async getL1GatewayAddress(
    erc20L1Address: string,
    l1Provider: Provider
  ): Promise<string> {
    await this.checkL1Network(l1Provider)

    const l1GatewayRouter = L1GatewayRouter__factory.connect(
      this.l2Network.tokenBridge.l1GatewayRouter,
      l1Provider
    )

    return (await l1GatewayRouter.functions.getGateway(erc20L1Address)).gateway
  }

  /**
   * Get the address of the l2 gateway for this token
   * @param erc20L1Address
   * @param l2Provider
   * @returns
   */
  public async getL2GatewayAddress(
    erc20L1Address: string,
    l2Provider: Provider
  ): Promise<string> {
    await this.checkL2Network(l2Provider)

    const l2GatewayRouter = L2GatewayRouter__factory.connect(
      this.l2Network.tokenBridge.l2GatewayRouter,
      l2Provider
    )

    return (await l2GatewayRouter.functions.getGateway(erc20L1Address)).gateway
  }

  /**
   * Approve tokens for deposit to the bridge. The tokens will be approved for the relevant gateway.
   * @param params
   * @returns
   */
  public async approveToken(
    params: TokenApproveParams
  ): Promise<ethers.ContractTransaction> {
    if (!SignerProviderUtils.signerHasProvider(params.l1Signer)) {
      throw new MissingProviderArbTsError('l1Signer')
    }
    await this.checkL1Network(params.l1Signer)

    // you approve tokens to the gateway that the router will use
    const gatewayAddress = await this.getL1GatewayAddress(
      params.erc20L1Address,
      params.l1Signer.provider
    )
    const contract = await ERC20__factory.connect(
      params.erc20L1Address,
      params.l1Signer
    )
    return contract.functions.approve(
      gatewayAddress,
      params.amount || Erc20Bridger.MAX_APPROVAL,
      params.overrides || {}
    )
  }

  /**
   * Get the L2 events created by a withdrawal
   * @param l2Provider
   * @param gatewayAddress
   * @param l1TokenAddress
   * @param fromAddress
   * @param filter
   * @returns
   */
  public async getL2WithdrawalEvents(
    l2Provider: Provider,
    gatewayAddress: string,
    filter: { fromBlock: BlockTag; toBlock: BlockTag },
    l1TokenAddress?: string,
    fromAddress?: string
  ): Promise<(WithdrawalInitiatedEvent['args'] & { txHash: string })[]> {
    await this.checkL2Network(l2Provider)

    const eventFetcher = new EventFetcher(l2Provider)
    const events = (
      await eventFetcher.getEvents(
        gatewayAddress,
        L2ArbitrumGateway__factory,
        contract =>
          contract.filters.WithdrawalInitiated(null, fromAddress || null),
        filter
      )
    ).map(a => ({ txHash: a.transactionHash, ...a.event }))

    return l1TokenAddress
      ? events.filter(
          log =>
            log.l1Token.toLocaleLowerCase() ===
            l1TokenAddress.toLocaleLowerCase()
        )
      : events
  }

  /**
   * Does the provided address look like a weth gateway
   * @param potentialWethGatewayAddress
   * @param l1Provider
   * @returns
   */
  private async looksLikeWethGateway(
    potentialWethGatewayAddress: string,
    l1Provider: Provider
  ) {
    try {
      const potentialWethGateway = L1WethGateway__factory.connect(
        potentialWethGatewayAddress,
        l1Provider
      )
      await potentialWethGateway.callStatic.l1Weth()
      return true
    } catch (err) {
      if (
        err instanceof Error &&
        (err as unknown as { code: ErrorCode }).code ===
          Logger.errors.CALL_EXCEPTION
      ) {
        return false
      } else {
        throw err
      }
    }
  }

  /**
   * Is this a known or unknown WETH gateway
   * @param gatewayAddress
   * @param l1Provider
   * @returns
   */
  private async isWethGateway(
    gatewayAddress: string,
    l1Provider: Provider
  ): Promise<boolean> {
    const wethAddress = this.l2Network.tokenBridge.l1WethGateway
    if (this.l2Network.isCustom) {
      // For custom network, we do an ad-hoc check to see if it's a WETH gateway
      if (await this.looksLikeWethGateway(gatewayAddress, l1Provider)) {
        return true
      }
      // ...otherwise we directly check it against the config file
    } else if (wethAddress === gatewayAddress) {
      return true
    }
    return false
  }

  /**
   * Get the L2 token contract at the provided address
   * @param l2Provider
   * @param l2TokenAddr
   * @returns
   */
  public getL2TokenContract(
    l2Provider: Provider,
    l2TokenAddr: string
  ): L2GatewayToken {
    return L2GatewayToken__factory.connect(l2TokenAddr, l2Provider)
  }

  /**
   * Get the L1 token contract at the provided address
   * @param l1Provider
   * @param l1TokenAddr
   * @returns
   */
  public getL1TokenContract(l1Provider: Provider, l1TokenAddr: string): ERC20 {
    return ERC20__factory.connect(l1TokenAddr, l1Provider)
  }

  /**
   * Get the corresponding L2 for the provided L1 token
   * @param erc20L1Address
   * @param l1Provider
   * @returns
   */
  public async getL2ERC20Address(
    erc20L1Address: string,
    l1Provider: Provider
  ): Promise<string> {
    await this.checkL1Network(l1Provider)

    const l1GatewayRouter = L1GatewayRouter__factory.connect(
      this.l2Network.tokenBridge.l1GatewayRouter,
      l1Provider
    )

    return await l1GatewayRouter.functions
      .calculateL2TokenAddress(erc20L1Address)
      .then(([res]) => res)
  }

  /**
   * Get the corresponding L1 for the provided L2 token
   * @param erc20L1Address
   * @param l1Provider
   * @returns
   */
  public async getL1ERC20Address(
    erc20L2Address: string,
    l2Provider: Provider
  ): Promise<string> {
    await this.checkL2Network(l2Provider)

    const arbERC20 = L2GatewayToken__factory.connect(erc20L2Address, l2Provider)

    return await arbERC20.functions.l1Address().then(([res]) => res)
  }

  /**
   * Whether the token has been disabled on the router
   * @param l1TokenAddress
   * @param l1Provider
   * @returns
   */
  public async l1TokenIsDisabled(
    l1TokenAddress: string,
    l1Provider: Provider
  ): Promise<boolean> {
    await this.checkL1Network(l1Provider)

    const l1GatewayRouter = L1GatewayRouter__factory.connect(
      this.l2Network.tokenBridge.l1GatewayRouter,
      l1Provider
    )

    return (
      (await l1GatewayRouter.l1TokenToGateway(l1TokenAddress)) ===
      DISABLED_GATEWAY
    )
  }

  private async getDepositParams(params: TokenDepositParams): Promise<{
    erc20L1Address: string
    amount: BigNumber
    l1CallValue: BigNumber
    maxSubmissionCost: BigNumber
    maxGas: BigNumber
    maxGasPrice: BigNumber
    destinationAddress: string
  }> {
    const { erc20L1Address, amount, l2Provider, l1Signer, destinationAddress } =
      params
    const { retryableGasOverrides } = params

    if (!SignerProviderUtils.signerHasProvider(l1Signer)) {
      throw new MissingProviderArbTsError('l1Signer')
    }

    // 1. get the params for a gas estimate
    const l1GatewayAddress = await this.getL1GatewayAddress(
      erc20L1Address,
      l1Signer.provider
    )
    const l1Gateway = L1ERC20Gateway__factory.connect(
      l1GatewayAddress,
      l1Signer.provider
    )
    const sender = await l1Signer.getAddress()
    const to = destinationAddress ? destinationAddress : sender
    const depositCalldata = await l1Gateway.getOutboundCalldata(
      erc20L1Address,
      sender,
      to,
      amount,
      '0x'
    )
    // The WETH gateway is the only deposit that requires callvalue in the L2 user-tx (i.e., the recently un-wrapped ETH)
    // Here we check if this is a WETH deposit, and include the callvalue for the gas estimate query if so
    const estimateGasCallValue = (await this.isWethGateway(
      l1GatewayAddress,
      l1Signer.provider
    ))
      ? amount
      : Zero

    const l2Dest = await l1Gateway.counterpartGateway()
    const gasEstimator = new L1ToL2MessageGasEstimator(l2Provider)

    let tokenGasOverrides: GasOverrides | undefined = retryableGasOverrides
    if (!tokenGasOverrides) tokenGasOverrides = {}
    // we never send l2 call value from l1 for tokens
    // since we check in the router that the value is submission cost
    // + gas price * gas
    tokenGasOverrides.sendL2CallValueFromL1 = false

    // we also add a hardcoded minimum maxgas for custom gateway deposits
    if (l1GatewayAddress === this.l2Network.tokenBridge.l1CustomGateway) {
      if (!tokenGasOverrides.maxGas) tokenGasOverrides.maxGas = {}
      tokenGasOverrides.maxGas.min = Erc20Bridger.MIN_CUSTOM_DEPOSIT_MAXGAS
    }

    // 2. get the gas estimates
    const estimates = await gasEstimator.estimateMessage(
      l1GatewayAddress,
      l2Dest,
      depositCalldata,
      estimateGasCallValue,
      tokenGasOverrides
    )

    return {
      maxGas: estimates.maxGasBid,
      maxSubmissionCost: estimates.maxSubmissionPriceBid,
      maxGasPrice: estimates.maxGasPriceBid,
      l1CallValue: estimates.totalDepositValue,
      destinationAddress: to,
      amount,
      erc20L1Address,
    }
  }

  private async depositTxOrGas<T extends boolean>(
    params: TokenDepositParams,
    estimate: T
  ): Promise<T extends true ? BigNumber : ethers.ContractTransaction>
  private async depositTxOrGas<T extends boolean>(
    params: TokenDepositParams,
    estimate: T
  ): Promise<BigNumber | ethers.ContractTransaction> {
    if (!SignerProviderUtils.signerHasProvider(params.l1Signer)) {
      throw new MissingProviderArbTsError('l1Signer')
    }
    await this.checkL1Network(params.l1Signer)
    await this.checkL2Network(params.l2Provider)
    if ((params.overrides as PayableOverrides | undefined)?.value) {
      throw new Error('L1 call value should be set through l1CallValue param')
    }

    const depositParams = await this.getDepositParams(params)
    const data = defaultAbiCoder.encode(
      ['uint256', 'bytes'],
      [depositParams.maxSubmissionCost, '0x']
    )

    const l1GatewayRouter = L1GatewayRouter__factory.connect(
      this.l2Network.tokenBridge.l1GatewayRouter,
      params.l1Signer
    )

    return await (estimate
      ? l1GatewayRouter.estimateGas
      : l1GatewayRouter.functions
    ).outboundTransfer(
      depositParams.erc20L1Address,
      depositParams.destinationAddress,
      depositParams.amount,
      depositParams.maxGas,
      depositParams.maxGasPrice,
      data,
      { ...(params.overrides || {}), value: depositParams.l1CallValue }
    )
  }

  /**
   * Estimate the gas required for a token deposit
   * @param params
   * @returns
   */
  public async depositEstimateGas(
    params: TokenDepositParams
  ): Promise<BigNumber> {
    return await this.depositTxOrGas(params, true)
  }

  /**
   * Execute a token deposit from L1 to L2
   * @param params
   * @returns
   */
  public async deposit(
    params: TokenDepositParams
  ): Promise<L1ContractCallTransaction> {
    const tx = await this.depositTxOrGas(params, false)
    return L1TransactionReceipt.monkeyPatchContractCallWait(tx)
  }

  private async withdrawTxOrGas<T extends boolean>(
    params: TokenWithdrawParams,
    estimate: T
  ): Promise<T extends true ? BigNumber : ethers.ContractTransaction>
  private async withdrawTxOrGas<T extends boolean>(
    params: TokenWithdrawParams,
    estimate: T
  ): Promise<BigNumber | ethers.ContractTransaction> {
    if (!SignerProviderUtils.signerHasProvider(params.l2Signer)) {
      throw new MissingProviderArbTsError('l2Signer')
    }
    await this.checkL2Network(params.l2Signer)

    const to = params.destinationAddress || (await params.l2Signer.getAddress())

    const l2GatewayRouter = L2GatewayRouter__factory.connect(
      this.l2Network.tokenBridge.l2GatewayRouter,
      params.l2Signer
    )

    return (estimate ? l2GatewayRouter.estimateGas : l2GatewayRouter.functions)[
      'outboundTransfer(address,address,uint256,bytes)'
    ](params.erc20l1Address, to, params.amount, '0x', params.overrides || {})
  }

  /**
   * Estimate gas for withdrawing tokens from L2 to L1
   * @param params
   * @returns
   */
  public async withdrawEstimateGas(
    params: TokenWithdrawParams
  ): Promise<BigNumber> {
    return this.withdrawTxOrGas(params, true)
  }

  /**
   * Withdraw tokens from L2 to L1
   * @param params
   * @returns
   */
  public async withdraw(
    params: TokenWithdrawParams
  ): Promise<L2ContractTransaction> {
    const tx = await this.withdrawTxOrGas(params, false)
    return L2TransactionReceipt.monkeyPatchWait(tx)
  }
}

/**
 * A token and gateway pair
 */
interface TokenAndGateway {
  tokenAddr: string
  gatewayAddr: string
}

/**
 * Admin functionality for the token bridge
 */
export class AdminErc20Bridger extends Erc20Bridger {
  /**
   * Register a custom token on the Arbitrum bridge
   * See https://developer.offchainlabs.com/docs/bridging_assets#the-arbitrum-generic-custom-gateway for more details
   * @param l1TokenAddress Address of the already deployed l1 token. Must inherit from https://developer.offchainlabs.com/docs/sol_contract_docs/md_docs/arb-bridge-peripherals/tokenbridge/ethereum/icustomtoken.
   * @param l2TokenAddress Address of the already deployed l2 token. Must inherit from https://developer.offchainlabs.com/docs/sol_contract_docs/md_docs/arb-bridge-peripherals/tokenbridge/arbitrum/iarbtoken.
   * @param l1Signer The signer with the rights to call registerTokenOnL2 on the l1 token
   * @param l2Provider Arbitrum rpc provider
   * @returns
   */
  public async registerCustomToken(
    l1TokenAddress: string,
    l2TokenAddress: string,
    l1Signer: Signer,
    l2Provider: Provider
  ): Promise<L1ContractTransaction> {
    await this.checkL1Network(l1Signer)
    await this.checkL2Network(l2Provider)

    const l1SenderAddress = await l1Signer.getAddress()

    const l1Token = ICustomToken__factory.connect(l1TokenAddress, l1Signer)
    const l2Token = IArbToken__factory.connect(l2TokenAddress, l2Provider)

    // sanity checks
    await l1Token.deployed()
    await l2Token.deployed()

    const l1AddressFromL2 = await l2Token.l1Address()
    if (l1AddressFromL2 !== l1TokenAddress) {
      throw new ArbTsError(
        `L2 token does not have l1 address set. Set address: ${l1AddressFromL2}, expected address: ${l1TokenAddress}.`
      )
    }
    const gasPriceEstimator = new L1ToL2MessageGasEstimator(l2Provider)

    // internally the registerTokenOnL2 sends two l1tol2 messages
    // the first registers the tokens and the second sets the gateways
    // we need to estimate gas for each of these l1tol2 messages
    // 1. registerTokenFromL1
    const il2CustomGateway = L2CustomGateway__factory.createInterface()
    const l2SetTokenCallData = il2CustomGateway.encodeFunctionData(
      'registerTokenFromL1',
      [[l1TokenAddress], [l2TokenAddress]]
    )

    const setTokenEstimates = await gasPriceEstimator.estimateMessage(
      this.l2Network.tokenBridge.l1CustomGateway,
      // l1SenderAddress,
      this.l2Network.tokenBridge.l2CustomGateway,
      l2SetTokenCallData,
      Zero
    )

    // 2. setGateway
    const iL2GatewayRouter = L2GatewayRouter__factory.createInterface()
    const l2SetGatewaysCallData = iL2GatewayRouter.encodeFunctionData(
      'setGateway',
      [[l1TokenAddress], [this.l2Network.tokenBridge.l1CustomGateway]]
    )

    const setGatwayEstimates = await gasPriceEstimator.estimateMessage(
      this.l2Network.tokenBridge.l1GatewayRouter,
      this.l2Network.tokenBridge.l2GatewayRouter,
      l2SetGatewaysCallData,
      Zero
    )

    // now execute the registration
    const customRegistrationTx = await l1Token.registerTokenOnL2(
      l2TokenAddress,
      setTokenEstimates.maxSubmissionPriceBid,
      setGatwayEstimates.maxSubmissionPriceBid,
      setTokenEstimates.maxGasBid,
      setGatwayEstimates.maxGasBid,
      setGatwayEstimates.maxGasPriceBid,
      setTokenEstimates.totalDepositValue,
      setGatwayEstimates.totalDepositValue,
      l1SenderAddress,
      {
        value: setTokenEstimates.totalDepositValue.add(
          setGatwayEstimates.totalDepositValue
        ),
      }
    )

    return L1TransactionReceipt.monkeyPatchWait(customRegistrationTx)
  }

  /**
   * Get all the gateway set events on the L1 gateway router
   * @param l1Provider
   * @param customNetworkL1GatewayRouter
   * @returns
   */
  public async getL1GatewaySetEvents(
    l1Provider: Provider,
    filter: { fromBlock: BlockTag; toBlock: BlockTag },
    customNetworkL1GatewayRouter?: string
  ): Promise<GatewaySetEvent['args'][]> {
    if (this.l2Network.isCustom && !customNetworkL1GatewayRouter) {
      throw new Error(
        'Must supply customNetworkL1GatewayRouter for custom network '
      )
    }
    await this.checkL1Network(l1Provider)

    const l1GatewayRouterAddress =
      customNetworkL1GatewayRouter || this.l2Network.tokenBridge.l1GatewayRouter

    const eventFetcher = new EventFetcher(l1Provider)
    return (
      await eventFetcher.getEvents(
        l1GatewayRouterAddress,
        L1GatewayRouter__factory,
        t => t.filters.GatewaySet(),
        filter
      )
    ).map(a => a.event)
  }

  /**
   * Get all the gateway set events on the L2 gateway router
   * @param l1Provider
   * @param customNetworkL1GatewayRouter
   * @returns
   */
  public async getL2GatewaySetEvents(
    l2Provider: Provider,
    filter: { fromBlock: BlockTag; toBlock: BlockTag },
    customNetworkL2GatewayRouter?: string
  ): Promise<GatewaySetEvent['args'][]> {
    if (this.l2Network.isCustom && !customNetworkL2GatewayRouter) {
      throw new Error(
        'Must supply customNetworkL2GatewayRouter for custom network '
      )
    }
    await this.checkL2Network(l2Provider)

    const l2GatewayRouterAddress =
      customNetworkL2GatewayRouter || this.l2Network.tokenBridge.l2GatewayRouter

    const eventFetcher = new EventFetcher(l2Provider)
    return (
      await eventFetcher.getEvents(
        l2GatewayRouterAddress,
        L1GatewayRouter__factory,
        t => t.filters.GatewaySet(),
        filter
      )
    ).map(a => a.event)
  }

  /**
   * Register the provided token addresses against the provided gateways
   * @param l1Signer
   * @param l2Provider
   * @param tokenGateways
   * @returns
   */
  public async setGateways(
    l1Signer: Signer,
    l2Provider: Provider,
    tokenGateways: TokenAndGateway[],
    maxGas: BigNumber = BigNumber.from(0)
  ): Promise<L1ContractCallTransaction> {
    if (!SignerProviderUtils.signerHasProvider(l1Signer)) {
      throw new MissingProviderArbTsError('l1Signer')
    }
    await this.checkL1Network(l1Signer)
    await this.checkL2Network(l2Provider)

    const l2GasPrice = await l2Provider.getGasPrice()

    const estimator = new L1ToL2MessageGasEstimator(l2Provider)
    const { submissionPrice } = await estimator.estimateSubmissionPrice(
      // 20 per address, 100 as buffer/ estimate for any additional calldata
      300 + 20 * (tokenGateways.length * 2)
    )

    const l1GatewayRouter = L1GatewayRouter__factory.connect(
      this.l2Network.tokenBridge.l1GatewayRouter,
      l1Signer.provider
    )

    const res = await l1GatewayRouter.functions.setGateways(
      tokenGateways.map(tG => tG.tokenAddr),
      tokenGateways.map(tG => tG.gatewayAddr),
      maxGas,
      l2GasPrice,
      submissionPrice,
      {
        value: submissionPrice,
      }
    )

    return L1TransactionReceipt.monkeyPatchContractCallWait(res)
  }
}
