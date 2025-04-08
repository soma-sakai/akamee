import { NextResponse } from 'next/server';
import type { Stripe } from 'stripe';

// APIハンドラー
export async function POST(req: Request) {
  try {
    // リファラーとオリジンのチェック
    const origin = req.headers.get('origin');
    const referer = req.headers.get('referer');
    
    // デプロイ環境に応じたサイトURL
    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL || 
                   (typeof self !== 'undefined' && self.location?.origin) || 
                   'http://localhost:3000';
                   
    const baseUrl = new URL(siteUrl).origin;
    
    const allowedOrigins = [
      siteUrl,
      baseUrl,
      'http://localhost:3000',
      'https://akamee-thrgdb47e-gradation.vercel.app',
      'https://akme.vercel.app',
      'https://akme-git-main-soma-sakais-projects.vercel.app'
    ].filter(Boolean) as string[];
    
    console.log(`[API] サイトURL: ${siteUrl}, ベースURL: ${baseUrl}`);
    console.log(`[API] リクエスト元: origin=${origin}, referer=${referer}`);
    
    // リファラーが許可されたオリジンから来ているか確認
    // 開発環境では検証をスキップ（より寛容に）
    const isDevMode = process.env.NODE_ENV === 'development';
    const isValidOrigin = isDevMode || !origin || allowedOrigins.some(allowed => origin.includes(allowed));
    const isValidReferer = isDevMode || !referer || allowedOrigins.some(allowed => referer.includes(allowed));
    
    if (!isValidOrigin && !isValidReferer) {
      console.warn(`[API] 不正なオリジンからのリクエスト: origin=${origin}, referer=${referer}`);
      return NextResponse.json(
        { error: '不正なリクエスト元からのアクセスです' },
        { status: 403 }
      );
    }

    // 遅延インポートでStripeモジュールを読み込む (Vercelデプロイでの問題回避策)
    let StripeSDK;
    try {
      const stripeModule = await import('stripe');
      StripeSDK = stripeModule.default;
    } catch (importError) {
      console.error('[API] Stripeモジュールのインポートに失敗:', importError);
      return NextResponse.json(
        { error: 'サーバー側でStripeモジュールのロードに失敗しました' },
        { status: 500 }
      );
    }
    
    // Stripeの初期化
    const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
    if (!stripeSecretKey) {
      console.error('[API] Stripe Secret Key is not configured');
      return NextResponse.json(
        { error: 'Stripe APIキーが設定されていません。環境変数を確認してください。' },
        { status: 500 }
      );
    }

    // APIバージョンを動的に扱うことでエラーを避ける
    let stripe;
    try {
      stripe = new StripeSDK(stripeSecretKey, {
        apiVersion: '2023-10-16' as any,
      });
    } catch (stripeInitError) {
      console.error('[API] Stripeの初期化に失敗:', stripeInitError);
      return NextResponse.json(
        { error: 'Stripe連携の初期化に失敗しました' },
        { status: 500 }
      );
    }

    // リクエストボディの解析
    let items;
    let purchaseType;
    
    try {
      const body = await req.json();
      items = body.items;
      purchaseType = body.purchaseType;
      
      if (!items || items.length === 0) {
        return NextResponse.json(
          { error: '商品情報が提供されていません' },
          { status: 400 }
        );
      }
      
      // 商品データの最低限の検証
      const hasInvalidItems = items.some((item: any) => {
        return (
          typeof item.price !== 'number' || 
          item.price <= 0 || 
          typeof item.name !== 'string' || 
          item.name.trim() === ''
        );
      });
      
      if (hasInvalidItems) {
        return NextResponse.json(
          { error: '無効な商品データが含まれています' },
          { status: 400 }
        );
      }
    } catch (error) {
      console.error('[API] JSON parsing error:', error);
      return NextResponse.json(
        { error: 'リクエストの解析に失敗しました' },
        { status: 400 }
      );
    }

    // 商品情報からStripeのline_itemsを作成
    const lineItems = items.map((item: any) => {
      // 画像URLが絶対URLであることを確認
      const imageUrls: string[] = [];
      if (item.images && Array.isArray(item.images) && item.images.length > 0) {
        // 画像URLが有効かチェック
        const firstImage = item.images[0];
        if (typeof firstImage === 'string' && firstImage.trim() !== '') {
          // URLが相対パスの場合は絶対URLに変換
          if (firstImage.startsWith('/')) {
            imageUrls.push(`${baseUrl}${firstImage}`);
          } else if (firstImage.startsWith('http')) {
            imageUrls.push(firstImage);
          }
        }
      }

      return {
        price_data: {
          currency: 'jpy',
          product_data: {
            name: item.name || '商品',
            description: item.description || '',
            images: imageUrls.length > 0 ? imageUrls : [],
          },
          unit_amount: item.price || 0,
        },
        quantity: item.quantity || 1,
      };
    });

    // サイトのベースURLを取得
    console.log('[API] サイトベースURL:', baseUrl);

    // チェックアウトセッションの作成
    const sessionConfig: any = {
      payment_method_types: ['card'],
      line_items: lineItems,
      mode: purchaseType === 'subscription' ? 'subscription' : 'payment',
      success_url: `${baseUrl}/checkout/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${baseUrl}/checkout/cancel`,
      billing_address_collection: 'auto',
      shipping_address_collection: {
        allowed_countries: ['JP'],
      },
      locale: 'ja',
    };

    try {
      const session = await stripe.checkout.sessions.create(sessionConfig);
      console.log('[API] Session created:', session.id);
      
      return NextResponse.json({ sessionId: session.id });
    } catch (stripeError: any) {
      console.error('[API] Stripe session creation error:', stripeError);
      return NextResponse.json(
        { error: `Stripeセッション作成エラー: ${stripeError.message || ''}` },
        { status: 500 }
      );
    }
  } catch (error: any) {
    console.error('[API] Unhandled error:', error);
    
    return NextResponse.json(
      { error: '決済処理中に予期せぬエラーが発生しました' },
      { status: 500 }
    );
  }
} 